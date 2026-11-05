import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { allowsAutoMergeProcessing, getPostMergeFinalizeBlocker, type Settings, type Task, type TaskStore } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { resolveIntegrationBranch, resolveMergeConfirmedGateBranch } from "./integration-branch.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";
import { isPushAfterMergeEnabled } from "./push-after-merge-policy.js";
import { createMergeWriteFence, type MergeWriteFence } from "./merge-write-fence.js";
import {
  mergeConfirmationReconcileEligible,
  reconcileConfirmedMergeLanding,
  type MergeConfirmationReconcileLiveness,
} from "./recover-confirmed-merge-reconcile.js";

const execFileAsync = promisify(execFile);
const COOLDOWN_MS = 5 * 60_000;
const branchAttempts = new Map<string, number>();
type Run = (args: string[], cwd: string, timeout: number, signal?: AbortSignal) => Promise<string>;
const runGit: Run = async (args, cwd, timeout, signal) => (await execFileAsync("git", args, {
  cwd, timeout, signal, maxBuffer: 1024 * 1024, encoding: "utf8",
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
})).stdout.trim();

function eligible(task: Task, settings: Settings): boolean {
  const leaseAge = Date.now() - Date.parse(task.checkoutLeaseRenewedAt ?? "");
  const leased = !!task.checkoutRunId && Number.isFinite(leaseAge) && leaseAge >= 0
    && leaseAge < (settings.taskStuckTimeoutMs ?? 10 * 60_000) * 3;
  return task.mergeDetails?.mergeConfirmed === true && !task.workspaceWorktrees
    && task.branchContext?.assignmentMode !== "shared"
    && !task.paused && !task.userPaused && !task.deletedAt && task.autoMerge !== false
    && !settings.globalPause && !settings.enginePaused
    && isPushAfterMergeEnabled(settings) && allowsAutoMergeProcessing(task, settings)
    && !getPostMergeFinalizeBlocker(task)
    && !leased && !isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock });
}

/** Retry remote delivery of proven landing only; never merge, rebase, or force-push. */
export async function recoverConfirmedMergePush(
  store: TaskStore,
  task: Task,
  settings: Settings,
  run: Run = runGit,
  suppliedFence?: MergeWriteFence,
  liveness?: MergeConfirmationReconcileLiveness,
): Promise<void> {
  if (!store.rootDir) return;
  /*
  FNXC:MergeConfirmationReconcile 2026-11-04-09:39:
  Entry admits either lane: push recovery (unchanged `eligible()` gates) or merge-confirmation
  reconciliation, which intentionally ignores autoMerge/pushAfterMerge settings — un-confirming a
  phantom restores the pre-landing state on `autoMerge:false` cards, and any re-merge then follows
  the card's normal human gates.

  FNXC:MergeConfirmationReconcile 2026-11-05-21:01 (KB-005):
  The trailing `liveness` bag (optional; existing call sites unchanged) is forwarded to the
  reconciliation predicate so sweep callers enforce the full liveness triple — a session/lock-live
  card is a silent no-op here, not an un-confirm racing a live executor.
  */
  if (!eligible(task, settings) && !mergeConfirmationReconcileEligible(task, settings, liveness)) return;
  const canPushRecover = eligible(task, settings);
  const details = task.mergeDetails!;
  const sha = details.commitSha;
  if (!sha || !/^[a-f0-9]{40,64}$/i.test(sha)) return;
  /*
  FNXC:MergeConfirmationReconcile 2026-11-05-21:01 (KB-005):
  Target-aware branch resolution. The recorded `mergeDetails.mergeTargetBranch` stays authoritative
  and costs ZERO extra git calls (the hot path is unchanged). Legacy rows without a recorded target
  fall back through `resolveMergeConfirmedGateBranch` — task `baseBranch`, then the project default
  from `resolveIntegrationBranch` — so a phantom confirmation can still be reconciled when the row
  never recorded where it landed (the SUBC-011 shape minus the target bookkeeping).
  `resolveIntegrationBranch` shells out to git, so it is invoked ONLY when the recorded target is
  absent; the resolved branch still passes the `check-ref-format` validation below like any
  recorded target would.
  */
  const recordedTarget = details.mergeTargetBranch?.trim() || "";
  const branch = recordedTarget || resolveMergeConfirmedGateBranch({
    recordedTargetBranch: recordedTarget,
    taskBaseBranch: task.baseBranch,
    projectDefaultBranch: await resolveIntegrationBranch(store.rootDir, settings),
  }).branch;
  const [remote = "origin", ...targetParts] = (settings.pushRemote?.trim() || "origin").split(/\s+/);
  const targetBranch = targetParts.join(" ") || branch;
  // Only configured remote names, never arbitrary URLs, options, or shell expressions.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) return;
  const target = `${remote}/${targetBranch}`;
  const recorded = details.pushRecovery;
  const now = Date.now();
  if (recorded?.target === target && recorded.commitSha === sha
    && (recorded.pushedAt || Date.parse(recorded.nextAttemptAt) > now)) return;
  for (const [key, until] of branchAttempts) if (until <= now) branchAttempts.delete(key);
  const key = `${store.rootDir}\0${target}`;
  if (branchAttempts.has(key)) return;
  branchAttempts.set(key, now + COOLDOWN_MS);
  const nextAttemptAt = new Date(now + COOLDOWN_MS).toISOString();
  const deadline = now + 10_000;
  const fence = suppliedFence ?? createMergeWriteFence({ taskId: task.id });
  const git = (args: string[]) => {
    fence.assertOwned();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Remote delivery recovery timed out.");
    return fence.signal ? run(args, store.rootDir, remaining, fence.signal) : run(args, store.rootDir, remaining);
  };
  let claimed = false;
  let failed = false;
  // The SHA the flow proves and delivers: the recorded SHA, or the main-side same-tree commit a
  // content-match reconciliation rewrote it to.
  let effectiveSha = sha;
  // Snapshot the claim gate judges; a content-match rewrite bumps updatedAt, so it must be re-read
  // from the store before the snapshot-fenced claim below can own the attempt.
  let flowSnapshot = task;
  const ownsAttempt = (live: Task) => live.mergeDetails?.commitSha === effectiveSha
    && live.mergeDetails.mergeTargetBranch === branch
    && live.mergeDetails.pushRecovery?.target === target
    && live.mergeDetails.pushRecovery.commitSha === effectiveSha
    && live.mergeDetails.pushRecovery.nextAttemptAt === nextAttemptAt;
  try {
    await git(["check-ref-format", `refs/heads/${branch}`]);
    await git(["check-ref-format", `refs/heads/${targetBranch}`]);
    /*
    FNXC:MergeConfirmationReconcile 2026-11-04-09:39:
    The is-ancestor proof gates the whole push-recovery flow. When it FAILS, the recorded
    "confirmed" landing is not on the local target branch at all — retrying delivery can never
    succeed and bookkeeping alone previously left the false confirmation deferred forever
    (SUBC-011). Reconcile instead: rewrite same-tree landings to the main-side SHA and continue the
    normal flow, or un-confirm a true phantom and re-open the merge in-column. Only reconcile-eligible
    tasks take that path; every other failure keeps the original bookkeeping behavior.
    */
    try {
      await git(["merge-base", "--is-ancestor", sha, `refs/heads/${branch}`]);
    } catch (ancestorError) {
      if (!mergeConfirmationReconcileEligible(task, settings, liveness)) throw ancestorError;
      const reconciled = await reconcileConfirmedMergeLanding({
        store, task, settings, branch, recordedSha: sha, run: git, fence,
      });
      if (reconciled.outcome === "content-match") {
        effectiveSha = reconciled.landedSha;
        const rewritten = await store.getTask(task.id);
        if (rewritten) flowSnapshot = rewritten;
        // Continue the normal push-recovery flow below with the reconciled main-side SHA.
      } else if (reconciled.outcome === "reopened" || reconciled.outcome === "exhausted") {
        return;
      } else {
        // Skipped (transient git failure, busy graph, missing workflow) — keep the legacy
        // bookkeeping path so the state stays observable and retries stay bounded.
        throw ancestorError;
      }
    }
    /*
    FNXC:MergeConfirmationReconcile 2026-11-04-09:39:
    Push-recovery-only lanes end here. A reconcile-eligible task that is not push-recovery-eligible
    (autoMerge:false, pushAfterMerge off, PR strategy, operator holds) has had its proof read: a
    content-match rewrite already landed through the reconcile fence, a phantom was re-opened, and
    remote delivery keeps ALL of its existing eligibility gates — no push-retry marker is written.
    */
    if (!canPushRecover) return;
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => {
      if (live.updatedAt !== flowSnapshot.updatedAt || !eligible(live, settings)
        || live.mergeDetails?.commitSha !== effectiveSha || live.mergeDetails.mergeTargetBranch !== branch) return null;
      claimed = true;
      return { mergeDetails: { ...live.mergeDetails, pushRecovery: { target, commitSha: effectiveSha, nextAttemptAt } } };
    }));
    if (!claimed) return;
    const current = await store.getTask(task.id);
    const currentSettings = await store.getSettings();
    if (!eligible(current, currentSettings) || currentSettings.pushRemote !== settings.pushRemote || !ownsAttempt(current)) return;
    const advertised = await git(["ls-remote", "--heads", remote, `refs/heads/${targetBranch}`]);
    const remoteSha = advertised.split(/\s+/)[0];
    let delivered = remoteSha === effectiveSha;
    if (!delivered && /^[a-f0-9]{40,64}$/i.test(remoteSha)) {
      // A newer remote tip may already contain this task; missing objects fall through to safe push.
      try {
        await git(["cat-file", "-e", `${remoteSha}^{commit}`]);
      } catch {
        await git(["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/heads/${targetBranch}`]);
      }
      try { await git(["merge-base", "--is-ancestor", effectiveSha, remoteSha]); delivered = true; } catch { /* non-force push decides */ }
    }
    if (!delivered) {
      const beforePush = await store.getTask(task.id);
      const beforePushSettings = await store.getSettings();
      if (!eligible(beforePush, beforePushSettings) || beforePushSettings.pushRemote !== settings.pushRemote || !ownsAttempt(beforePush)) return;
      await git(["push", remote, `${effectiveSha}:refs/heads/${targetBranch}`]);
    }
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => ownsAttempt(live)
      ? { mergeDetails: { ...live.mergeDetails, pushRecovery: { target, commitSha: sha, nextAttemptAt, pushedAt: new Date().toISOString() } } }
      : null));
    await fence.write("log", () => store.logEntry(task.id, `[post-merge] Confirmed landed commit ${sha.slice(0, 12)} is available on ${target}; verification may collect hosted CI evidence.`));
  } catch (error) {
    failed = true;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => (claimed ? ownsAttempt(live) : live.updatedAt === task.updatedAt && eligible(live, settings))
      ? { mergeDetails: { ...live.mergeDetails, pushRecovery: { target, commitSha: sha, nextAttemptAt, error: message } } }
      : null)).catch(() => undefined);
    await fence.write("log", () => store.logEntry(task.id, `[post-merge] Remote delivery recovery failed for ${target}; retry after ${nextAttemptAt}. ${message}`)).catch(() => undefined);
  } finally {
    if (!failed) branchAttempts.delete(key);
  }
}
