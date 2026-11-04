/*
FNXC:RulesetPrLanding 2026-11-04-09:42:
FIX-6 (SUBC-013 incident). A GitHub ruleset with required status checks on `refs/heads/<target>`
declines EVERY direct landing push with
`! [remote rejected] <branch> -> <branch> (push declined due to repository rule violations)`,
which the landing contract (local advance + direct push) classified as a non-fatal push failure —
the merge recorded as landed locally while origin stayed behind forever. This module implements the
feature-detected fallback for that single landing:

  1. Detect the rule-violation rejection signature on the landing push failure (feature detection
     ONLY — Fusion never force-pushes, never reads, disables, or mutates rulesets).
  2. Emit one bounded `push:ruleset-declined` run-audit row and engage PR landing: push the landing
     commit to the task branch (`refs/heads/<task branch>` — the ruleset only covers the target
     branch), `gh pr create` against the target branch, wait BOUNDEDLY for required checks
     (`gh pr checks`, capped), then `gh pr merge --squash` preserving the landing commit message.
  3. Sync the local integration ref to the post-squash-merge tip inside the caller's merge-write
     fence: `git fetch` + CAS `update-ref` (SUBC-011 precedent — the squash sha is a SIBLING of the
     local landing sha, not a descendant, so the advance requires the explicit non-fast-forward
     opt-in and a tree-equality proof that the squash captured exactly the landing tree; on any
     mismatch the local ref is left untouched and the next merge's push reconciles).

The squash-merge sha is NEW and different from the local landing sha, so the recorded bookkeeping
(commitSha) must be reconciled to the actual post-merge target tip — that reconciliation belongs to
this fallback, not to an operator. Callers drive it through their existing post-push
mergeDetails-refresh seams by returning `newMainSha`.

Exclusions (deliberate): workspace lands keep their own per-repository publication machinery
(`landWorkspaceTask` / `landOneRepo`), and `mergeStrategy: "pull-request"` (`merging-pr`) tasks keep
their existing PR flow — this module is only reachable from the single-repository direct-merge
push-after-merge publication step. `autoMerge:false` cards keep the existing PR-review contract
unchanged: publication (and therefore this fallback) only runs for manual merges or when auto-merge
processing is allowed, so a PR created here is authorized to be squash-merged by the same
authorization that would have direct-pushed.

The checks wait is bounded (~15 min cap, poll interval) and fully injectable (`deps`) so tests use a
fake clock and an immediate sleep — production never gains an unbounded wait and tests never gain a
real polling loop (FN-5048).
*/
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskStore } from "@fusion/core";
import { createLogger } from "../logger.js";
import { assertMergeGenerationOwned, type MergeWriteFence } from "./merge-write-fence.js";
import { advanceIntegrationBranchRef } from "./merger-ref-update-advance.js";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import type { RunAuditor } from "../util/run-audit.js";

const rulesetLandingLog = createLogger("merger-ruleset-pr-landing");

const execFileAsync = promisify(execFile);

/** Bounded wait for required checks: 15 minutes total, 30-second poll interval. */
export const RULESET_PR_CHECKS_TIMEOUT_MS = 15 * 60 * 1000;
export const RULESET_PR_CHECKS_POLL_INTERVAL_MS = 30_000;
const GH_COMMAND_TIMEOUT_MS = 120_000;
const GIT_COMMAND_TIMEOUT_MS = 120_000;

/** `gh pr checks` exit codes: 0 = all passed, 8 = pending, anything else = failing. */
const GH_CHECKS_EXIT_PENDING = 8;

/** The ref-level rejection half of the signature (git client output). */
const RULESET_REJECTION_REF = /\[?remote rejected\]?|failed to push some refs/i;
/** The rule-violation half of the signature (remote-declined reason / GitHub error code). */
const RULESET_REJECTION_REASON = /push declined due to repository rule|repository rule violations|GH006/i;

/*
FNXC:RulesetPrLanding 2026-11-04-09:42:
Feature detection only. A plain pre-receive decline ("pre-receive hook declined") matches the ref
half but not the rule half and keeps the existing non-fatal failure path; a transient transport
failure matches neither and keeps the transient-retry path.
*/
export function isRulesetPushRejection(message: string): boolean {
  return RULESET_REJECTION_REF.test(message) && RULESET_REJECTION_REASON.test(message);
}

/** Errors thrown by the default gh runner carry the exit code the checks poll needs. */
export class GhCommandError extends Error {
  readonly args: string[];
  readonly exitCode: number;
  readonly stdout: string;
  constructor(args: string[], exitCode: number, stdout: string, message: string) {
    super(message);
    this.name = "GhCommandError";
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
  }
}

export interface RulesetPrLandingDeps {
  /** Runs git in `cwd`, returns trimmed stdout, throws on non-zero exit. */
  git?: (args: string[], cwd: string, timeoutMs?: number) => Promise<string>;
  /** Runs gh in `cwd`, returns trimmed stdout, throws `GhCommandError` with `exitCode` on failure. */
  gh?: (args: string[], cwd: string, timeoutMs?: number) => Promise<string>;
  /** Wait pacing between check polls; injectable so tests never install a real polling loop. */
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock for the bounded-wait deadline; injectable so tests drive it with fake time. */
  now?: () => number;
}

const defaultDeps: Required<Pick<RulesetPrLandingDeps, "git" | "gh" | "sleep" | "now">> = {
  git: async (args, cwd, timeoutMs = GIT_COMMAND_TIMEOUT_MS) => {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  },
  gh: async (args, cwd, timeoutMs = GH_COMMAND_TIMEOUT_MS) => {
    try {
      const { stdout } = await execFileAsync("gh", args, { cwd, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim();
    } catch (error: unknown) {
      const err = error as { code?: number | string; stdout?: string | Buffer };
      const stdout = typeof err.stdout === "string" ? err.stdout : Buffer.isBuffer(err.stdout) ? err.stdout.toString() : "";
      throw new GhCommandError(args, typeof err.code === "number" ? err.code : -1, stdout, error instanceof Error ? error.message : String(error));
    }
  },
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/*
FNXC:RulesetPrLanding 2026-11-04-09:42:
Test seam for the injectable runners, following the `export const __test__ = testHooks` precedent
(merger-ref-update-advance.ts). Production always uses `defaultDeps`; only tests install overrides,
and they must restore `null` afterwards.
*/
let injectedDeps: RulesetPrLandingDeps | null = null;
export const __test__ = {
  setDeps(deps: RulesetPrLandingDeps | null): void {
    injectedDeps = deps;
  },
};

export type RulesetPrLandingOutcome = "landed" | "checks-timeout" | "failed";

export interface RulesetPrLandingResult {
  outcome: RulesetPrLandingOutcome;
  taskId: string;
  remote: string;
  /** PR base branch (the integration target the ruleset protects). */
  targetBranch: string;
  /** PR head branch (the task branch the landing commit was pushed to). */
  headBranch: string;
  prUrl?: string;
  prNumber?: number;
  /** The local landing commit that was delivered through the PR. */
  landingSha: string;
  /** Post-squash-merge target-branch tip (set when landed). */
  newMainSha?: string;
  /** Whether the local integration ref was CAS-advanced to `newMainSha`. */
  localRefAdvanced?: boolean;
  error?: string;
}

export interface EngageRulesetPrLandingInput {
  store: TaskStore;
  projectRootDir: string;
  taskId: string;
  remote: string;
  /** PR base — the protected integration target. */
  targetBranch: string;
  /** The local integration ref the fallback CAS-advances to the post-merge tip. */
  integrationBranch: string;
  /** Local landing commit tip to deliver through the PR. */
  landingSha: string;
  /** Expected current tip of the local integration ref (CAS guard for the local sync). */
  expectedLocalRefSha: string;
  /** The original rejection output — the load-bearing fact for audit and logs. */
  rejectionMessage: string;
  audit: RunAuditor;
  fence: MergeWriteFence;
  signal?: AbortSignal;
  /** Best-effort other-checkout catch-up after the local ref advance (merge-advance auto-sync). */
  syncCheckouts?: (input: { previousSha: string; newSha: string }) => Promise<void>;
  deps?: RulesetPrLandingDeps;
}

interface PrLandingTaskView {
  branch?: string | null;
  mergeDetails?: { prLanding?: unknown } & Record<string, unknown>;
}

/**
 * FNXC:RulesetPrLanding 2026-11-04-09:42:
 * Entry point used by the landing-push failure sites. Emits the bounded `push:ruleset-declined`
 * audit row, runs the PR landing flow, writes the honest checks-pending park on timeout, and
 * returns a typed outcome. Failures never throw into the caller's non-fatal publication contract —
 * the caller keeps its existing failure handling with the original rejection message.
 */
export async function engageRulesetPrLanding(input: EngageRulesetPrLandingInput): Promise<RulesetPrLandingResult> {
  const { store, projectRootDir, taskId, remote, targetBranch, landingSha, fence, signal } = input;
  const deps: Required<Pick<RulesetPrLandingDeps, "git" | "gh" | "sleep" | "now">> = { ...defaultDeps, ...(injectedDeps ?? {}), ...(input.deps ?? {}) };

  const base: RulesetPrLandingResult = { outcome: "failed", taskId, remote, targetBranch, headBranch: `fusion/${taskId.toLowerCase()}`, landingSha };

  // One bounded audit row per engagement; ids/fixed-outcomes only. Terminal outcomes surface
  // through the existing push:origin rows and the task log.
  await emitBoundedRunAudit(store as RunAuditSinkHost, {
    taskId,
    agentId: "merger",
    runId: `merge-${taskId}`,
    domain: "git",
    mutationType: "push:ruleset-declined",
    target: taskId,
    metadata: { taskId, remote, branch: targetBranch, outcome: "pr-fallback-engaged" },
  }, { log: rulesetLandingLog }).catch(() => undefined);

  let liveTask: PrLandingTaskView | null = null;
  try {
    liveTask = (await store.getTask(taskId)) as PrLandingTaskView | null;
  } catch {
    liveTask = null;
  }
  // The task's own branch is the PR head when it looks like a task branch; otherwise fall back to
  // the deterministic fusion/<task-id> branch (same convention as the push recovery branch).
  const recordedBranch = liveTask?.branch?.trim();
  const headBranch = recordedBranch && recordedBranch.startsWith("fusion/")
    ? recordedBranch
    : `fusion/${taskId.toLowerCase()}`;
  base.headBranch = headBranch;

  await fence.write("log", () => store.logEntry(
    taskId,
    `Push to ${remote}/${targetBranch} was declined by repository rules — engaging PR landing fallback (head ${headBranch} → base ${targetBranch})`,
    "RulesetPrLanding",
  ).catch(() => undefined));

  try {
    // 1. Deliver the landing commit on the task branch. Plain push only — never force.
    assertMergeGenerationOwned(signal, taskId);
    await deps.git(["push", remote, `${landingSha}:refs/heads/${headBranch}`], projectRootDir);

    // 2. Open the PR preserving the landing commit message (re-entry: an existing PR for the head
    //    branch is reused, which is how a checks-timeout park converges on the next attempt).
    assertMergeGenerationOwned(signal, taskId);
    const [subject, body] = await Promise.all([
      deps.git(["log", "-1", "--format=%s", landingSha], projectRootDir).catch(() => taskId),
      deps.git(["log", "-1", "--format=%b", landingSha], projectRootDir).catch(() => ""),
    ]);
    let prUrl = "";
    try {
      prUrl = await deps.gh(
        ["pr", "create", "--base", targetBranch, "--head", headBranch, "--title", subject, "--body", body.trim() || `(empty)`],
        projectRootDir,
      );
    } catch (createError: unknown) {
      const createMessage = createError instanceof Error ? createError.message : String(createError);
      if (!/already exists/i.test(createMessage)) throw createError;
      prUrl = await deps.gh(["pr", "view", headBranch, "--json", "url", "--jq", ".url"], projectRootDir).catch(() => "");
    }
    const prNumber = /\/pull\/(\d+)/.exec(prUrl)?.[1];
    base.prUrl = prUrl || undefined;
    base.prNumber = prNumber ? Number.parseInt(prNumber, 10) : undefined;

    // 3. Bounded wait for the required checks. The deadline uses the injectable clock so tests
    //    drive the whole loop with fake time (FN-5048 — no real polling loops in tests).
    const deadline = deps.now() + RULESET_PR_CHECKS_TIMEOUT_MS;
    let checksGreen = false;
    for (;;) {
      assertMergeGenerationOwned(signal, taskId);
      let checkFailure: string | undefined;
      try {
        await deps.gh(["pr", "checks", prUrl || headBranch], projectRootDir, GH_COMMAND_TIMEOUT_MS);
        checksGreen = true;
      } catch (checkError: unknown) {
        const exitCode = checkError instanceof GhCommandError ? checkError.exitCode : -1;
        // Exit 8 = checks still pending → keep polling until the deadline; anything else failed.
        if (exitCode !== GH_CHECKS_EXIT_PENDING) {
          checkFailure = checkError instanceof Error ? checkError.message : String(checkError);
        }
      }
      if (checksGreen) break;
      if (checkFailure) {
        // Non-pending, non-zero exit before the deadline: checks failed — no amount of waiting
        // merges this PR; fail the fallback honestly and let the caller keep its push contract.
        const result: RulesetPrLandingResult = {
          ...base,
          outcome: "failed",
          error: `PR checks failed for ${prUrl || headBranch}: ${checkFailure ?? "unknown gh pr checks failure"}`,
        };
        await fence.write("log", () => store.logEntry(taskId, `PR landing fallback stopped: required checks failed on ${prUrl || headBranch}`, "RulesetPrLandingFailed").catch(() => undefined));
        return result;
      }
      if (deps.now() >= deadline) {
        return await parkChecksPending({ ...base, outcome: "checks-timeout" }, input, prUrl, headBranch);
      }
      await deps.sleep(RULESET_PR_CHECKS_POLL_INTERVAL_MS);
    }

    // 4. Squash-merge preserving the landing commit message.
    assertMergeGenerationOwned(signal, taskId);
    await deps.gh(
      ["pr", "merge", prUrl || headBranch, "--squash", "--subject", subject, "--body", body.trim() || `(empty)`],
      projectRootDir,
    );

    // 5. Sync the local integration ref to the post-merge tip inside the merge-write fence.
    assertMergeGenerationOwned(signal, taskId);
    const sync = await syncLocalIntegrationRefAfterPrMerge(input, deps, prUrl, headBranch);
    const result: RulesetPrLandingResult = {
      ...base,
      outcome: "landed",
      newMainSha: sync.newMainSha || undefined,
      localRefAdvanced: sync.advanced,
    };
    await fence.write("log", () => store.logEntry(
      taskId,
      `PR landing fallback merged ${prUrl || headBranch} (squash) — ${targetBranch} advanced to ${sync.newMainSha || "(unresolved)"}`,
      "RulesetPrLanding",
    ).catch(() => undefined));
    return result;
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await fence.write("log", () => store.logEntry(taskId, `PR landing fallback failed: ${message}`, "RulesetPrLandingFailed").catch(() => undefined));
    return { ...base, outcome: "failed", error: message };
  }
}

/**
 * FNXC:RulesetPrLanding 2026-11-04-09:42:
 * The honest checks-timeout park. `blockedBy` stays empty and NO column move happens: the card has
 * already been finalized by the merge path (publication runs post-finalization), and automatic
 * moves may never leave a terminal lane (lifecycle containment) — `needs-replan` would also be the
 * wrong semantics, since the plan is not the problem; delivery is pending. The card instead carries
 * the exact `PR CHECKS PENDING: <pr url>` marker plus durable `mergeDetails.prLanding` state so an
 * operator (or the next merge attempt, which re-detects the existing PR) converges the delivery.
 */
async function parkChecksPending(
  result: RulesetPrLandingResult,
  input: EngageRulesetPrLandingInput,
  prUrl: string,
  headBranch: string,
): Promise<RulesetPrLandingResult> {
  const { store, taskId, fence } = input;
  const marker = `PR CHECKS PENDING: ${prUrl || headBranch}`;
  const parked: RulesetPrLandingResult = { ...result, prUrl: prUrl || undefined, error: marker };
  // Re-read immediately before the write so the park never clobbers bookkeeping written by the
  // merge body while the bounded wait was running.
  const liveTask = (await store.getTask(taskId).catch(() => null)) as PrLandingTaskView | null;
  await fence.write("lifecycle", () => store.updateTask(taskId, {
    error: marker,
    mergeDetails: {
      ...(liveTask?.mergeDetails ?? {}),
      prLanding: { state: "checks-pending", prUrl: prUrl || undefined, headBranch, updatedAt: new Date().toISOString() },
    },
  }));
  await fence.write("log", () => store.logEntry(
    taskId,
    `${marker} — required checks did not report within the bounded wait (${RULESET_PR_CHECKS_TIMEOUT_MS / 60000} min). The PR stays open; retry the merge (or Retry the task) to re-enter the fallback, which re-detects the existing PR and squash-merges it once checks are green.`,
    "RulesetPrLanding",
  ).catch(() => undefined));
  return parked;
}

/**
 * FNXC:RulesetPrLanding 2026-11-04-09:42:
 * Post-squash-merge local sync. `git fetch`, then CAS-advance the local integration ref to the
 * fetched tip only when BOTH hold: the ref is still at the expected pre-advance tip, and the
 * fetched squash commit's tree equals the landing commit's tree (SUBC-011 precedent — never move a
 * local ref onto content that is not exactly what was proven landed). The squash sha is a sibling
 * of the landing sha, so the advance uses the explicit non-fast-forward opt-in. On mismatch the
 * local ref is left untouched (logged); the next merge's push reconciles. Returns the fetched tip
 * so callers can reconcile `mergeDetails.commitSha` to the reachable post-merge commit.
 */
async function syncLocalIntegrationRefAfterPrMerge(
  input: EngageRulesetPrLandingInput,
  deps: Required<Pick<RulesetPrLandingDeps, "git" | "gh" | "sleep" | "now">>,
  prUrl: string,
  headBranch: string,
): Promise<{ newMainSha: string; advanced: boolean }> {
  const { store, projectRootDir, taskId, remote, targetBranch, integrationBranch, landingSha, expectedLocalRefSha, audit, fence, signal, syncCheckouts } = input;
  await deps.git(["fetch", remote, targetBranch], projectRootDir);
  const newMainSha = await deps.git(["rev-parse", "FETCH_HEAD"], projectRootDir).catch(() => "");
  if (!newMainSha || newMainSha === landingSha) return { newMainSha, advanced: false };

  const [landingTree, newTree] = await Promise.all([
    deps.git(["rev-parse", `${landingSha}^{tree}`], projectRootDir).catch(() => ""),
    deps.git(["rev-parse", `${newMainSha}^{tree}`], projectRootDir).catch(() => ""),
  ]);
  const treeMatches = !!landingTree && landingTree === newTree;
  assertMergeGenerationOwned(signal, taskId);
  const advance = await advanceIntegrationBranchRef({
    rootDir: projectRootDir,
    projectRootDir,
    integrationBranch,
    newSha: newMainSha,
    expectedCurrentSha: expectedLocalRefSha,
    taskId,
    audit,
    allowNonFastForward: true,
  });
  if (!advance.advanced) {
    await fence.write("log", () => store.logEntry(
      taskId,
      `PR landing fallback merged the PR, but ${integrationBranch} could not be advanced locally (${advance.reason}${treeMatches ? "" : "; squash tree differs from the landing tree"}) — local ref left as-is; the next merge's push will reconcile`,
      "RulesetPrLanding",
    ).catch(() => undefined));
    return { newMainSha, advanced: false };
  }
  if (syncCheckouts) {
    try {
      await syncCheckouts({ previousSha: expectedLocalRefSha, newSha: newMainSha });
    } catch (syncError: unknown) {
      await fence.write("log", () => store.logEntry(taskId, `PR landing fallback: merge-advance auto-sync threw — continuing: ${syncError instanceof Error ? syncError.message : String(syncError)}`, "RulesetPrLanding").catch(() => undefined));
    }
  }
  // Best-effort durable marker that this landing was delivered via the PR fallback.
  const liveTask = await store.getTask(taskId).catch(() => null);
  const details = liveTask?.mergeDetails;
  if (details) {
    await fence.write("lifecycle", () => store.updateTask(taskId, {
      mergeDetails: {
        ...details,
        prLanding: { state: "landed", prUrl: prUrl || undefined, headBranch, updatedAt: new Date().toISOString() },
      },
    }));
  }
  return { newMainSha, advanced: true };
}
