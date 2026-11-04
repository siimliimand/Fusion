/**
 * FNXC:CodeOrganization 2026-08-03-15:20:
 * Outer createWorktree loop + squash-import + post-create remote rebase peeled from
 * TaskExecutor (U4 Slice B). Inject deps; keep thin class facades for spy/assignment surfaces.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RunAuditEventInput, RunMutationContext, Settings } from "@fusion/core";
import { isBranchConflictError } from "../execution/branch-conflicts.js";
import { StaleWorktreeIndexLockError } from "../worktree/worktree-stale-lock.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { executorLog } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { installTaskWorktreeIdentityGuard } from "../worktree/worktree-hooks.js";
import { quoteShellArg } from "./shell-quote.js";
import { getWorktreeBranchMap, isRegisteredWorktree, NonRetryableWorktreeError } from "./worktree-registry-helpers.js";

const execAsync = promisify(exec);

export type WorktreeOuterStore = {
  updateTask: (taskId: string, patch: Record<string, unknown>) => Promise<unknown>;
  getSettings: () => Promise<Settings | Partial<Settings>>;
  /** Mirrors TaskStore.logEntry so safe breadcrumbs match main (action, outcome?, runContext?). */
  logEntry: (
    taskId: string,
    action: string,
    outcome?: string | undefined,
    runContext?: RunMutationContext | undefined,
  ) => Promise<unknown>;
  /** FN-9175 bounded run-audit seam sink; optional so minimal test adapters stay assignable. */
  recordRunAuditEvent?: (input: RunAuditEventInput) => unknown;
};

export type WorktreeOuterCreateDeps = {
  rootDir: string;
  store: WorktreeOuterStore;
  maxWorktreeRetries: number;
  worktreeRetryDelaysMs: number[];
  resolveWorktreeStartPoint: (startPoint: string, taskId: string) => Promise<string | null>;
  planSquashImportFromDep: (
    taskId: string,
    depTip: string,
    originalStartPoint: string | undefined,
  ) => Promise<{ depTip: string; mainBase: string; label: string } | null>;
  tryCreateWorktree: (
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber?: number,
    recoveryDepth?: number,
    allowSiblingBranchRename?: boolean,
    settings?: Partial<Settings>,
  ) => Promise<{ path: string; branch: string }>;
  squashImportDepIntoWorktree: (
    worktreePath: string,
    taskId: string,
    depTip: string,
    label: string,
  ) => Promise<void>;
  rebaseNewWorktreeOntoRemote: (
    worktreePath: string,
    branch: string,
    taskId: string,
    settingsOverride?: Settings,
  ) => Promise<void>;
};

/**
 * Resolve a stored baseBranch to a concrete commit SHA.
 *
 * Returns `null` (not throw) when the ref cannot be resolved — typically
 * because the upstream dep's branch was merged and deleted while this task
 * sat queued/stuck. Callers should treat null as "fall back to default base"
 * rather than fail the task permanently.
 */
export async function resolveWorktreeStartPoint(
  rootDir: string,
  store: Pick<WorktreeOuterStore, "logEntry">,
  startPoint: string,
  taskId: string,
): Promise<string | null> {
  const command = isAbsolute(startPoint) && existsSync(startPoint)
    ? `git -C "${startPoint}" rev-parse --verify HEAD^{commit}`
    : `git rev-parse --verify "${startPoint}^{commit}"`;

  try {
    const { stdout } = await execAsync(command, { cwd: rootDir });
    return stdout.trim() || startPoint;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await store.logEntry(
      taskId,
      `Worktree base ref "${startPoint}" is missing — falling back to default base`,
      errorMessage,
    );
    return null;
  }
}

/**
 * Squash-merge the dep's content into a worktree that's already branched
 * off main. Produces one commit on the worktree branch carrying the dep's
 * content, instead of inheriting the dep's individual commits. Best-effort:
 * any failure (conflict, hooks, IO) leaves the worktree at main and the
 * caller proceeds — the dependent task will then need to import the dep's
 * content itself, but the worktree itself is still usable.
 */
export async function squashImportDepIntoWorktree(
  store: Pick<WorktreeOuterStore, "logEntry">,
  worktreePath: string,
  taskId: string,
  depTip: string,
  label: string,
): Promise<void> {
  // No-op when dep is already represented in the worktree's history.
  try {
    await execAsync(
      `git merge-base --is-ancestor ${quoteShellArg(depTip)} HEAD`,
      { cwd: worktreePath },
    );
    return;
  } catch {
    // Not an ancestor — proceed.
  }

  // Try a squash-merge. `--no-commit` is implied by `--squash`; the merge
  // either stages the dep's diff or fails (conflicts / unrelated histories).
  try {
    await execAsync(
      `git merge --squash --allow-unrelated-histories ${quoteShellArg(depTip)}`,
      { cwd: worktreePath },
    );
  } catch (err) {
    // Reset any partial state so the worktree stays usable, then rethrow
    // so the caller can decide whether to log/fall-through.
    await execAsync("git reset --hard HEAD", { cwd: worktreePath }).catch(
      () => undefined,
    );
    throw err;
  }

  // If no diff was staged the dep is content-equivalent to main; nothing
  // to commit.
  try {
    await execAsync("git diff --cached --quiet", { cwd: worktreePath });
    return; // exit 0 → no staged changes, nothing to commit
  } catch {
    // exit non-zero → staged changes exist, proceed to commit.
  }

  // Always non-empty (subject + body via two -m args). Drop
  // --allow-empty-message: we never want git to silently accept an empty
  // message — a missing message here would make the commit hard to
  // attribute / explain in `git log` and break downstream consumers that
  // parse merge metadata from commit messages.
  const subject = `chore(${taskId}): import dependency content from ${label}`;
  const body =
    `Squash-imported the working tree of ${label} as a single commit so this ` +
    `branch carries the dep's content without inheriting its individual commits. ` +
    `If the dep is later squash-merged to main, this commit's patch-id should ` +
    `match the merge and rebase cleanly.`;
  try {
    await execAsync(
      `git commit -m ${quoteShellArg(subject)} -m ${quoteShellArg(body)}`,
      { cwd: worktreePath },
    );
  } catch (commitErr) {
    await execAsync("git reset --hard HEAD", { cwd: worktreePath }).catch(
      () => undefined,
    );
    throw commitErr;
  }

  await store.logEntry(
    taskId,
    `Squash-imported dependency content from ${label} into worktree (single import commit instead of inheriting raw commits)`,
  );
}

/**
 * After creating a fresh task worktree, fetch the configured remote and
 * rebase the task branch onto `<remote>/<defaultBranch>`. The result is a
 * branch that contains origin's tip plus any local main commits, so the
 * eventual merge has fewer surprises and the executor sees the freshest
 * code its peers/CI may have published.
 *
 * No-op when `worktreeRebaseBeforeMerge` is disabled, no remote is
 * configured/resolvable, or the rebase produces conflicts (we abort and
 * leave the worktree as-is so the executor can still run).
 */
/**
 * FNXC:WorktreeRebase 2026-08-09-00:48:
 * A fresh worktree must refresh against the same integration-branch-first contract that
 * selected its start point. Root checkout may be on a sibling task branch and must never
 * select this rebase target. Refresh remains best-effort; enabled skips/failures are logged.
 */
export async function rebaseNewWorktreeOntoRemote(
  rootDir: string,
  store: WorktreeOuterStore,
  worktreePath: string,
  branch: string,
  taskId: string,
  settingsOverride?: Settings,
): Promise<void> {
  let settings: Settings | Partial<Settings> | undefined = settingsOverride;
  if (!settings) {
    try {
      settings = await store.getSettings();
    } catch {
      return;
    }
  }
  if (settings.worktreeRebaseBeforeMerge === false) return;

  /*
  FNXC:WorktreeRebase 2026-08-09-00:48:
  Match TaskExecutor.safeLogEntry arity: (taskId, message, undefined, runContext).
  Tests pin the four-argument breadcrumb shape for enabled skips and failures.
  */
  const safeLog = (action: string) => {
    try {
      void Promise.resolve(store.logEntry(taskId, action, undefined, undefined)).catch(() => undefined);
    } catch {
      // best-effort breadcrumb
    }
  };

  let remote = settings.worktreeRebaseRemote?.trim() || "";
  if (!remote) {
    try {
      const { stdout } = await execAsync("git remote", { cwd: rootDir });
      const remotes = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (remotes.includes("origin")) remote = "origin";
      else if (remotes.length === 1) remote = remotes[0];
    } catch {
      // No remote resolvable — nothing to rebase against.
    }
  }
  if (!remote) {
    safeLog("Skipped new worktree rebase refresh — no remote was resolvable");
    return;
  }

  let integrationBranch: string;
  try {
    integrationBranch = await resolveIntegrationBranch(rootDir, settings as Settings, { logger: executorLog });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Worktree rebase: could not resolve integration branch for ${taskId}: ${message}`);
    safeLog(`Skipped new worktree rebase refresh — integration branch could not be resolved for ${remote}`);
    return;
  }

  const remoteRef = `${remote}/${integrationBranch}`;

  try {
    await execAsync(`git fetch ${quoteShellArg(remote)} ${quoteShellArg(integrationBranch)}`, { cwd: rootDir });
  } catch (err) {
    executorLog.warn(
      `Worktree rebase: fetch ${remote} ${integrationBranch} failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    safeLog(`Could not refresh new worktree rebase target ${remoteRef} — fetch failed; kept local base.`);
    return;
  }

  try {
    await execAsync(`git rebase ${quoteShellArg(remoteRef)}`, { cwd: worktreePath });
    safeLog(`Rebased new worktree branch ${branch} onto ${remoteRef}`);
  } catch (rebaseErr) {
    const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
    executorLog.warn(
      `Worktree rebase: rebase onto ${remoteRef} failed for ${taskId} — aborting and leaving local base intact: ${msg}`,
    );
    try {
      await execAsync("git rebase --abort", { cwd: worktreePath });
    } catch {
      // best-effort
    }
    safeLog(
      `Could not rebase new worktree onto ${remoteRef} — kept local base. The merge-time rebase will retry with conflict resolution.`,
    );
  }
}

/*
FNXC:Worktrees 2026-07-19-15:47:
Branch-needing task work must be created with `git worktree add` in an isolated checkout. Per the
AGENTS.md “Prefer main For Direct Work; Use Worktrees For Branches” standing rule, rootDir is
never switched with `git checkout` or `git switch` to select a task branch; see the primary-checkout
invariant regression test for the executable guard.
*/
/*
FNXC:WorktreeUnlandedGuard 2026-11-04-09:39:
INVARIANT: worktree (re)acquisition must never move or delete a `fusion/<taskId>` branch ref whose
tip carries commits that are not contained in the acquisition base. The state between "executor
committed" and "AI merge landed" is NORMAL, and a refresh or dependency import is an optimization —
never a precondition for node work (SUBC-011: a re-acquisition rebuilt the branch from base and the
implementation commit left the branch; it survived only as a loose object referenced by a mission
branch, where a `git gc` could have destroyed it).

Before any branch re-create (`git worktree add -b`, recovery `git branch -D`, `checkout -B`) or
dependency squash-import in the executor outer acquisition, the guard measures
`rev-list --count <baseTip>..<branchTip>`. A nonzero count means a rebuild would orphan those
commits, so the rebuild AND the import are skipped; acquisition hands back a usable checkout for the
existing branch tip instead and surfaces the refusal (task log + `worktree:branch-refresh-refused`
audit). When the tip IS contained in the base the build proceeds exactly as before, and a rebuild
that re-points the ref is still audited (`worktree:branch-rebuild-proceeded`) so the destructive
class stays observable.

Surfaces covered: every caller routed through `createWorktree` here — TaskExecutor task acquisition,
foreach-instance worktrees (build-foreach-worktree-deps) and spawned-agent child worktrees
(create-spawn-agent-tool).

Surfaces deliberately excluded, with their existing fences:
- Workspace per-repo acquisition (`acquireWorkspaceRepoWorktree`) does NOT route through this
  primitive; it has its own lease/fence/baseline machinery (FN-9059/FN-179) and must never be
  refused by this guard.
- `reanchorBranchToBase` (`checkout -B`) fires only after `classifyBootstrapMisbinding` proves zero
  own AND zero non-attributed commits on the branch (worktree-acquisition resume verify,
  executor/bootstrap-misbinding-recovery, auto-recovery-handlers/branch-worktree,
  recovery/foreign-only-contamination) — nothing discardable can exist there.
- `refreshReusedWorktreeBase` rebases own commits and only `reset --hard` when the rev-list count
  is 0; the backend bare-branch collision ladder deletes only `tip-already-merged`/`fully-subsumed`
  tips.

The guard fails OPEN: when branch tip, base tip, or the count cannot be proven (missing refs, git
errors), acquisition proceeds exactly as before — an unprovable state must not block execution.
This path is not lifecycle-moving; user pauses and `autoMerge:false` behavior are unchanged.
*/
export type UnlandedBranchGuardVerdict = {
  unlanded: boolean;
  unlandedCommitCount: number;
  /** Resolved pre-acquisition branch tip, when the branch ref existed and resolved. */
  branchTipSha?: string;
  /** Resolved base tip the acquisition would rebuild from, when it resolved. */
  baseTipSha?: string;
};

/** No-op verdict used when the guard cannot prove anything (fail-open) or nothing is unlanded. */
const landedVerdict: UnlandedBranchGuardVerdict = { unlanded: false, unlandedCommitCount: 0 };

async function revParseBranchTip(rootDir: string, branch: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(
      `git rev-parse --verify ${quoteShellArg(`refs/heads/${branch}`)}^{commit}`,
      { cwd: rootDir },
    );
    const tip = stdout.trim();
    return /^[a-f0-9]{40,64}$/i.test(tip) ? tip : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Measure the commits on `branch` that a rebuild to `baseRef` would orphan.
 * Fails open (unlanded=false) whenever either side cannot be resolved or the count errors.
 */
export async function detectUnlandedBranchCommits(
  rootDir: string,
  branch: string,
  baseRef: string,
): Promise<UnlandedBranchGuardVerdict> {
  const branchTipSha = await revParseBranchTip(rootDir, branch);
  if (!branchTipSha) return landedVerdict;
  let baseTipSha: string;
  try {
    const { stdout } = await execAsync(
      `git rev-parse --verify ${quoteShellArg(`${baseRef}^{commit}`)}`,
      { cwd: rootDir },
    );
    baseTipSha = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(baseTipSha)) return landedVerdict;
  } catch {
    return landedVerdict;
  }
  let unlandedCommitCount = 0;
  try {
    const { stdout } = await execAsync(
      `git rev-list --count ${quoteShellArg(`${baseTipSha}..${branchTipSha}`)}`,
      { cwd: rootDir },
    );
    const parsed = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return landedVerdict;
    unlandedCommitCount = parsed;
  } catch {
    return landedVerdict;
  }
  return unlandedCommitCount > 0
    ? { unlanded: true, unlandedCommitCount, branchTipSha, baseTipSha }
    : { unlanded: false, unlandedCommitCount: 0, branchTipSha, baseTipSha };
}

type WorktreeIdentityGuardSettings = Partial<
  Pick<
    Settings,
    "commitMsgHookEnabled" | "taskPrefix" | "taskAttributionTrailerNames" | "commitAuthorEnabled" | "commitAuthorName" | "commitAuthorEmail"
  >
>;

async function installIdentityGuardBestEffort(
  worktreePath: string,
  taskId: string,
  branch: string,
  settings: WorktreeIdentityGuardSettings,
): Promise<void> {
  try {
    await installTaskWorktreeIdentityGuard({
      worktreePath,
      taskId,
      expectedBranch: branch,
      commitMsgHookEnabled: settings.commitMsgHookEnabled,
      taskPrefix: settings.taskPrefix,
      taskAttributionTrailerName: settings.taskAttributionTrailerNames?.[0],
      commitAuthorEnabled: settings.commitAuthorEnabled,
      commitAuthorName: settings.commitAuthorName,
      commitAuthorEmail: settings.commitAuthorEmail,
    });
  } catch (error) {
    executorLog.warn(
      `Unlanded-branch keep: identity guard install failed for ${taskId} at ${worktreePath} (continuing): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * FNXC:WorktreeUnlandedGuard 2026-11-04-09:39:
 * Hand back a usable checkout for a branch whose unlanded commits forbid a rebuild. Preference
 * order: an existing registered worktree already checked out on the branch, the requested path when
 * it is already a registered worktree, a fresh checkout attached to the branch AT ITS TIP (never
 * `-b`/`-f`, so the ref never moves), and finally the branch's registered holder. Throws a
 * non-retryable error when nothing can be secured — deletion of the branch is never a fallback.
 */
async function keepUnlandedBranchWorktree(
  deps: WorktreeOuterCreateDeps,
  settings: Partial<Settings>,
  input: {
    branch: string;
    path: string;
    taskId: string;
    unlandedCommitCount: number;
    baseRef: string;
  },
): Promise<{ path: string; branch: string }> {
  const { branch, path, taskId } = input;
  const branchHolders = await getWorktreeBranchMap(deps.rootDir).catch(() => new Map<string, string>());
  const holderPath = branchHolders.get(branch);
  if (holderPath && existsSync(holderPath)) return { path: holderPath, branch };
  if (existsSync(path) && (await isRegisteredWorktree(deps.rootDir, path).catch(() => false))) {
    return { path, branch };
  }
  const attach = async (): Promise<{ path: string; branch: string }> => {
    await execAsync(`git worktree add ${quoteShellArg(path)} ${quoteShellArg(branch)}`, { cwd: deps.rootDir });
    await installIdentityGuardBestEffort(path, taskId, branch, settings);
    return { path, branch };
  };
  try {
    return await attach();
  } catch (firstError) {
    // A leftover unregistered directory blocks the attach; clear it only under the same
    // "not a registered worktree" rule the fresh-create path applies, then retry once.
    if (existsSync(path) && !(await isRegisteredWorktree(deps.rootDir, path).catch(() => true))) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      try {
        return await attach();
      } catch (retryError) {
        throw new NonRetryableWorktreeError(
          `Unlanded-branch keep failed for ${taskId}: branch ${branch} carries ${input.unlandedCommitCount} commit(s) not in ${input.baseRef}; ` +
            `rebuild was refused and attaching the branch failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
        );
      }
    }
    throw new NonRetryableWorktreeError(
      `Unlanded-branch keep failed for ${taskId}: branch ${branch} carries ${input.unlandedCommitCount} commit(s) not in ${input.baseRef}; ` +
        `rebuild was refused and attaching the branch failed: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
    );
  }
}

export async function createWorktree(
  deps: WorktreeOuterCreateDeps,
  branch: string,
  path: string,
  taskId: string,
  startPoint?: string,
  allowSiblingBranchRename = false,
): Promise<{ path: string; branch: string }> {
  // Track the worktree path we're attempting to use (may change during recovery)
  const currentPath = path;
  let resolvedStartPoint: string | undefined;
  if (startPoint) {
    const resolved = await deps.resolveWorktreeStartPoint(startPoint, taskId);
    if (resolved === null) {
      // Stored baseBranch no longer exists (e.g., upstream dep merged and branch
      // deleted while this task sat queued/stuck). Clear it on the task so any
      // subsequent retry branches from the default base, and proceed from HEAD.
      await deps.store.updateTask(taskId, { executionStartBranch: null });
    } else {
      resolvedStartPoint = resolved;
    }
  }

  // When the task declares a non-main base (a sibling task's branch), the
  // legacy behavior was to fork the worktree from that branch's tip,
  // inheriting all of its commits. That caused content leakage when the
  // dep was later squash-merged to main: the dep's raw commits became
  // orphans whose content already existed in main, blocking the
  // dependent's own merge with phantom conflicts.
  //
  // Prevention: instead of forking from the dep's tip, fork from `main`
  // (or the configured remote/main if rebase-from-remote is enabled) and
  // then `git merge --squash` the dep's content into a single import
  // commit. The dependent branch then carries main's history + 1 commit
  // for the dep's content; if the dep is later squash-merged to main, the
  // patch-id on that import commit will match main's squash and Layer 2
  // recovery (or a clean rebase) handles it.
  //
  // Fall-soft: any failure in this path falls back to the legacy behavior
  // so we don't break worktree creation for setups where the squash flow
  // can't run (no main branch resolvable, network down, etc.).
  const squashImport = resolvedStartPoint
    ? await deps.planSquashImportFromDep(taskId, resolvedStartPoint, startPoint)
    : null;
  const initialStartPoint = squashImport ? squashImport.mainBase : resolvedStartPoint;
  const settings = await deps.store.getSettings();

  /*
   * FNXC:WorktreeUnlandedGuard 2026-11-04-09:39:
   * Prove the branch is fully contained in the acquisition base BEFORE any rebuild. The base is the
   * concrete start point the create path would rebuild from (squash-import mainBase when an import
   * is planned, the resolved start point otherwise); without a resolvable base the guard fails open.
   */
  const guardBaseRef = squashImport ? squashImport.mainBase : resolvedStartPoint;
  const guardVerdict = guardBaseRef
    ? await detectUnlandedBranchCommits(deps.rootDir, branch, guardBaseRef)
    : landedVerdict;
  if (guardVerdict.unlanded && guardBaseRef) {
    const kept = await keepUnlandedBranchWorktree(deps, settings, {
      branch,
      path: currentPath,
      taskId,
      unlandedCommitCount: guardVerdict.unlandedCommitCount,
      baseRef: guardBaseRef,
    });
    await deps.store.logEntry(
      taskId,
      `Worktree refresh skipped: branch ${branch} has ${guardVerdict.unlandedCommitCount} commit(s) not in ${guardBaseRef}; nothing discarded`,
    );
    await emitBoundedRunAudit(deps.store, {
      agentId: "system",
      runId: `${taskId}:worktree-unlanded-guard`,
      taskId,
      domain: "git",
      mutationType: "worktree:branch-refresh-refused",
      target: branch,
      metadata: {
        taskId,
        branch,
        base: guardBaseRef,
        unlandedCommitCount: guardVerdict.unlandedCommitCount,
        outcome: "skipped",
      },
    });
    return kept;
  }

  for (let attempt = 0; attempt < deps.maxWorktreeRetries; attempt++) {
    try {
      const result = await deps.tryCreateWorktree(
        branch,
        currentPath,
        taskId,
        initialStartPoint,
        attempt,
        0,
        allowSiblingBranchRename,
        settings,
      );
      /*
       * FNXC:WorktreeUnlandedGuard 2026-11-04-09:39:
       * Happy-path observability: a rebuild that re-pointed the branch ref is audited so the
       * discard-capable class stays visible. With the guard above, this can only fire when the
       * previous tip was fully contained in the base, so no unlanded commit is ever the subject.
       */
      if (guardVerdict.branchTipSha) {
        const rebuiltTip = await revParseBranchTip(deps.rootDir, branch);
        if (rebuiltTip && rebuiltTip !== guardVerdict.branchTipSha) {
          await emitBoundedRunAudit(deps.store, {
            agentId: "system",
            runId: `${taskId}:worktree-unlanded-guard`,
            taskId,
            domain: "git",
            mutationType: "worktree:branch-rebuild-proceeded",
            target: branch,
            metadata: {
              taskId,
              branch,
              base: guardBaseRef ?? "",
              unlandedCommitCount: 0,
              outcome: "rebuild-proceeded",
            },
          });
        }
      }
      // Squash-import dep content into the freshly created worktree so the
      // branch contains main's history + 1 import commit instead of the
      // dep's raw commits.
      if (squashImport) {
        await deps.squashImportDepIntoWorktree(
          result.path,
          taskId,
          squashImport.depTip,
          squashImport.label,
        ).catch((importErr: unknown) => {
          executorLog.warn(
            `Squash-import of ${squashImport.label} into ${result.branch} failed for ${taskId} (continuing without): ${importErr instanceof Error ? importErr.message : String(importErr)}`,
          );
        });
      }
      /*
       * FNXC:WorktreeRebase 2026-08-09-00:48:
       * Fetch and rebase the just-created task branch only when the setting is enabled.
       * Failures here never abort task setup.
       */
      await deps.rebaseNewWorktreeOntoRemote(result.path, result.branch, taskId).catch((err: unknown) => {
        executorLog.warn(
          `Post-create worktree rebase failed for ${taskId} (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isLastAttempt = attempt === deps.maxWorktreeRetries - 1;
      const isBranchConflict = isBranchConflictError(error);
      const isTerminalWorktreeError = error instanceof NonRetryableWorktreeError || error instanceof StaleWorktreeIndexLockError || isBranchConflict;

      if (isLastAttempt || isTerminalWorktreeError) {
        await deps.store.logEntry(
          taskId,
          `Worktree creation failed after ${deps.maxWorktreeRetries} attempts`,
          errorMessage,
        );
        if (isBranchConflict) {
          throw error;
        }
        throw new Error(
          `Failed to create worktree after ${deps.maxWorktreeRetries} attempts: ${errorMessage}`,
        );
      }

      // Wait before retry (exponential backoff)
      const delay = deps.worktreeRetryDelaysMs[attempt] || 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but TypeScript needs a return
  throw new Error("Unexpected exit from worktree creation retry loop");
}
