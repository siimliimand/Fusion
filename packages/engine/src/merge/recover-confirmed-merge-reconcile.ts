import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  computeWorkflowIrPin,
  isMergeRegionNode,
  resolveWorkflowIrForTaskWithProvenance,
  type Settings,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowIrNode,
} from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";
import { isMergeActiveStatus } from "./merge-active-status.js";
import { hasFreshCheckoutLease } from "./post-merge-gate-reseed.js";
import type { MergeWriteFence } from "./merge-write-fence.js";

/*
FNXC:MergeConfirmationReconcile 2026-11-04-09:39:
`mergeDetails.mergeConfirmed` is treated as proof-of-landing by finalization, but nothing used to
revoke it when the recorded SHA turned out to never have landed on the target branch (SUBC-011: a
false confirmation deferred finalization for ~20 hours while the verifier honestly failed because
the implementation existed nowhere reachable). Recovery now reconciles that state in place:

1. CONTENT-MATCH SELF-HEAL — when a commit with the SAME TREE as the recorded commit exists on the
   target branch (a squash landing of the same content under a different SHA), the recorded SHAs are
   rewritten to the main-side commit and the normal push-recovery flow continues.
2. TRUE PHANTOM — when the content is nowhere on the target branch, the false confirmation is
   cleared in ONE `updateTaskAtomic` fence and the merge is RE-OPENED by seeding a continuation at
   the task's merge-region entry node with sourceColumn/targetColumn = task.column (an in-column
   re-entry; `replaceActiveTaskWorkflowContinuation` is the ONLY sanctioned continuation writer and
   no backward column move happens here).
3. BOUNDED ATTEMPTS — per-task `mergeConfirmationReconcileCount` caps re-opens; on exhaustion the
   task parks `failed` with the honest-blocked marker below instead of looping forever.

Fences: reconciliation NEVER touches a SHA that IS an ancestor (the healthy path), never runs while
a merge is actually active or the graph holds an active work item, and never runs on workspace tasks
(their per-repo landing records are FN-9056/FN-9059 territory, not `mergeDetails`). Unlike push
recovery itself, reconciliation is ALLOWED for `autoMerge:false` cards and ignores
`pushAfterMerge`: un-confirming restores the pre-landing state, and the re-merge then follows the
card's normal human gates. All audit emission is bounded best-effort (FN-9175) and never includes
prose — ids, SHAs, counts, and fixed outcomes only.

FNXC:MergeConfirmationReconcile 2026-11-05-21:01 (KB-005):
The predicate takes an OPTIONAL `liveness` bag merged into the `isTaskExecutionLive` deps so sweep
callers can inject their own task-active probe (the canonical liveness triple: registered session
path, executing lock, isTaskActive) without the predicate reaching into caller state. Callers that
already gate through finalization/merge-pending flows keep passing nothing.
*/

/** Bounded re-open attempts before the honest-blocked park. */
export const MAX_MERGE_CONFIRMATION_RECONCILE_ATTEMPTS = 3;

export const MERGE_CONFIRMATION_RECONCILE_EXHAUSTED_PREFIX = "MERGE-CONFIRMED RECONCILIATION EXHAUSTED";

/** Bounded window of the target branch scanned for a same-tree landing commit. */
const CONTENT_MATCH_SCAN_COMMITS = 500;

type Run = (args: string[], cwd: string, timeout: number, signal?: AbortSignal) => Promise<string>;

export function mergeConfirmationReconcileExhaustedError(sha: string, branch: string, attempts: number): string {
  return `${MERGE_CONFIRMATION_RECONCILE_EXHAUSTED_PREFIX}: recorded SHA ${sha} not on ${branch} after ${attempts} attempts`;
}

/**
 * Reconciliation predicate. Deliberately DIFFERENT from push-recovery `eligible()`: it ignores
 * autoMerge/pushAfterMerge settings and post-merge finalize blockers (a blocked post-merge gate is
 * exactly the stuck state being repaired), but still excludes merge-active statuses, live
 * execution, fresh checkout leases, pauses, deletion, engine/global pauses, workspace tasks, and
 * shared-branch group members.
 */
export interface MergeConfirmationReconcileLiveness {
  /** Extra task-active probe merged into the liveness triple (sweep wiring, KB-005). */
  isTaskActive?: (taskId: string) => boolean;
}

export function mergeConfirmationReconcileEligible(
  task: Task,
  settings: Settings,
  liveness?: MergeConfirmationReconcileLiveness,
): boolean {
  return task.mergeDetails?.mergeConfirmed === true && !task.workspaceWorktrees
    && task.branchContext?.assignmentMode !== "shared"
    && !task.paused && !task.userPaused && !task.deletedAt
    && !settings.globalPause && !settings.enginePaused
    && !isMergeActiveStatus(task.status)
    && !hasFreshCheckoutLease(task, settings)
    && !isTaskExecutionLive(task.id, {
      activeSessionRegistry,
      executingTaskLock,
      ...(liveness?.isTaskActive ? { isTaskActive: liveness.isTaskActive } : {}),
    });
}

export type ConfirmedMergeReconcileOutcome =
  | { outcome: "content-match"; landedSha: string }
  | { outcome: "reopened" }
  | { outcome: "exhausted" }
  | { outcome: "skipped"; reason: "transient-proof-failure" | "graph-not-idle" | "no-workflow-selection" | "no-merge-region-node" | "unconfirm-refused" | "reseed-failed-compensated" };

/** Prefer the deterministic merge authority: gate, then attempt, then PR doors, then any merge-region node. */
function pickMergeRegionEntryNode(ir: WorkflowIr, column: string): WorkflowIrNode | undefined {
  if (ir.version !== "v2" || !Array.isArray(ir.nodes)) return undefined;
  const inColumn = ir.nodes.filter((node) => node.column === column && isMergeRegionNode(node));
  for (const kind of ["merge-gate", "merge-attempt", "pr-merge", "pr-create"] as const) {
    const found = inColumn.find((node) => node.kind === kind);
    if (found) return found;
  }
  return inColumn[0];
}

async function emitReconcileAudit(
  store: TaskStore,
  input: { taskId: string; recordedSha: string; branch: string; outcome: string; attempt: number },
): Promise<void> {
  await emitBoundedRunAudit(store, {
    agentId: "system",
    runId: `${input.taskId}:merge-confirmed-reconcile`,
    taskId: input.taskId,
    domain: "git",
    mutationType: "merge:confirmed-merge-reconciled",
    target: input.recordedSha,
    // FNXC:MergeConfirmationReconcile 2026-11-05-21:01 (KB-005): ids/SHAs/outcomes only — branch
    // names are permitted git-domain metadata (cf. push:recovery-branch), never prose.
    metadata: {
      taskId: input.taskId,
      recordedSha: input.recordedSha,
      branch: input.branch,
      outcome: input.outcome,
      attempt: input.attempt,
    },
  });
}

export interface ReconcileConfirmedMergeLandingInput {
  store: TaskStore;
  task: Task;
  settings: Settings;
  /** Local target branch whose refs/heads/<branch> tip must contain the recorded landing. */
  branch: string;
  recordedSha: string;
  /** Fence-owned, deadline-bounded git runner shared with push recovery. */
  run: Run;
  fence: MergeWriteFence;
}

/**
 * Reconcile a merge confirmation whose recorded SHA is NOT an ancestor of the local target branch.
 * Called by `recoverConfirmedMergePush` only after that ancestor check has FAILED.
 */
export async function reconcileConfirmedMergeLanding(
  input: ReconcileConfirmedMergeLandingInput,
): Promise<ConfirmedMergeReconcileOutcome> {
  const { store, task, settings, branch, recordedSha, run, fence } = input;
  const previousAttempts = task.mergeDetails?.mergeConfirmationReconcileCount ?? 0;
  const audit = (outcome: string, attempt: number) =>
    emitReconcileAudit(store, { taskId: task.id, recordedSha, branch, outcome, attempt });

  if (previousAttempts >= MAX_MERGE_CONFIRMATION_RECONCILE_ATTEMPTS) {
    const attempts = previousAttempts;
    let parked = false;
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => {
      if (live.updatedAt !== task.updatedAt || live.mergeDetails?.mergeConfirmed !== true
        || live.mergeDetails.commitSha !== recordedSha
        || live.paused || live.userPaused || live.deletedAt
        || !mergeConfirmationReconcileEligible(live, settings)) return null;
      parked = true;
      return {
        status: "failed",
        error: mergeConfirmationReconcileExhaustedError(recordedSha, branch, attempts),
      };
    }));
    if (parked) {
      await fence.write("log", () => store.logEntry(task.id, mergeConfirmationReconcileExhaustedError(recordedSha, branch, attempts)));
      await audit("exhausted", attempts);
      return { outcome: "exhausted" };
    }
    return { outcome: "skipped", reason: "unconfirm-refused" };
  }

  // ── Proof chain. ANY failure here is a transient git condition, never evidence of a phantom —
  // fail closed to the caller's existing bookkeeping rather than un-confirming on a flaky git.
  let recordedTree: string;
  let branchLog: string;
  try {
    // Proves the target branch ref resolves; its tip is what the content scan below walks.
    await run(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], store.rootDir, 10_000);
    recordedTree = await run(["rev-parse", `${recordedSha}^{tree}`], store.rootDir, 10_000);
    branchLog = await run(
      ["log", "--format=%H %T", `--max-count=${String(CONTENT_MATCH_SCAN_COMMITS)}`, `refs/heads/${branch}`],
      store.rootDir,
      10_000,
    );
  } catch {
    return { outcome: "skipped", reason: "transient-proof-failure" };
  }

  // 1. Content-match self-heal: same-tree commit on the target branch (squash landing under a new SHA).
  const trees = new Map<string, string>();
  for (const line of branchLog.split("\n")) {
    const [commitSha, treeSha] = line.trim().split(/\s+/);
    if (/^[a-f0-9]{40,64}$/i.test(commitSha ?? "") && /^[a-f0-9]{40,64}$/i.test(treeSha ?? "")) trees.set(treeSha, commitSha);
  }
  const mainSideSha = trees.get(recordedTree.trim());
  if (mainSideSha) {
    let rewritten = false;
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => {
      if (live.updatedAt !== task.updatedAt || live.mergeDetails?.mergeConfirmed !== true
        || live.mergeDetails.commitSha !== recordedSha) return null;
      rewritten = true;
      return {
        mergeDetails: {
          ...live.mergeDetails,
          commitSha: mainSideSha,
          ...(live.mergeDetails.landedBranchTipSha ? { landedBranchTipSha: mainSideSha } : {}),
        },
      };
    }));
    if (!rewritten) return { outcome: "skipped", reason: "unconfirm-refused" };
    await fence.write("log", () => store.logEntry(task.id, `[post-merge] Recorded landing ${recordedSha.slice(0, 12)} matches same-content commit ${mainSideSha.slice(0, 12)} on ${branch}; landing proof reconciled.`));
    await audit("content-match", previousAttempts);
    return { outcome: "content-match", landedSha: mainSideSha };
  }

  // 2. True phantom: re-open the merge in-column. Validate the graph is idle and the task's own
  // workflow has a merge-region entry BEFORE clearing the confirmation, so the card is never left
  // un-confirmed with no driver.
  if (typeof store.listWorkflowWorkItemsForTask !== "function"
    || typeof store.replaceActiveTaskWorkflowContinuation !== "function") {
    return { outcome: "skipped", reason: "transient-proof-failure" };
  }
  let ir: WorkflowIr;
  try {
    const items = await store.listWorkflowWorkItemsForTask(task.id);
    if (items.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state))) {
      return { outcome: "skipped", reason: "graph-not-idle" };
    }
    const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
    // A guessed IR (named selection that failed to resolve) is not this task's graph — fail closed.
    if (resolved.source === "default" && !resolved.selectionAbsent) {
      return { outcome: "skipped", reason: "no-workflow-selection" };
    }
    ir = resolved.ir;
  } catch {
    return { outcome: "skipped", reason: "transient-proof-failure" };
  }
  const mergeNode = pickMergeRegionEntryNode(ir, task.column);
  if (!mergeNode) return { outcome: "skipped", reason: "no-merge-region-node" };

  const items = await store.listWorkflowWorkItemsForTask(task.id).catch(() => []);
  const cleared: { value: boolean } = { value: false };
  await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => {
    if (live.updatedAt !== task.updatedAt || live.column !== task.column
      || live.mergeDetails?.mergeConfirmed !== true || live.mergeDetails.commitSha !== recordedSha
      || live.paused || live.userPaused || live.deletedAt
      || !mergeConfirmationReconcileEligible(live, settings)) return null;
    cleared.value = true;
    /*
    FNXC:MergeConfirmationReconcile 2026-11-05-21:01 (KB-005):
    The un-confirm must be TRUTHFUL: it drops the same false-landing fields the FN-5627 fast-path
    clears (project-engine.ts) — mergedAt and the stat/no-op attribution fields are lies once the
    recorded landing is proven false, and leaving them turned the reconciliation into a quieter
    version of the poisoned row it repairs. mergeTargetBranch stays (it describes where the NEXT
    landing should be proven) alongside the reconciliation record.
    */
    const {
      commitSha: _dropSha,
      pushRecovery: _dropRecovery,
      mergedAt: _dropMergedAt,
      landedFiles: _dropLandedFiles,
      filesChanged: _dropFilesChanged,
      insertions: _dropInsertions,
      deletions: _dropDeletions,
      noOpVerifiedShortCircuit: _dropNoOpShortCircuit,
      landedFilesAttributionRestricted: _dropAttributionRestricted,
      ...restDetails
    } = live.mergeDetails;
    return {
      mergeDetails: {
        ...restDetails,
        mergeConfirmed: false,
        mergeConfirmationReconcileCount: (live.mergeDetails.mergeConfirmationReconcileCount ?? 0) + 1,
        reconciliation: {
          clearedAt: new Date().toISOString(),
          reason: "recorded-sha-not-on-target" as const,
          recordedSha,
        },
      },
    };
  }));
  if (!cleared.value) return { outcome: "skipped", reason: "unconfirm-refused" };

  // 3. Seed the in-column merge re-entry through the only sanctioned continuation writer. A failed
  // seed is compensated: the confirmation is restored so the card never sits un-confirmed with no
  // driver; the operator-facing truth stays in the task log.
  const continuationSequence = items.length;
  try {
    await fence.write("finalization", () => store.replaceActiveTaskWorkflowContinuation({
      runId: `${task.id}:merge-confirmed-reconcile:${mergeNode.id}:${continuationSequence}`,
      taskId: task.id,
      nodeId: mergeNode.id,
      kind: "task" as const,
      state: "runnable" as const,
      waitReason: null,
      blockedReason: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      retryAfter: null,
      sourceColumn: task.column,
      targetColumn: task.column,
      continuationSequence,
      stableWorkflowRunId: `${task.id}:${ir.name}`,
      irHash: computeWorkflowIrPin(ir, mergeNode.id).irHash,
    }));
  } catch (seedError) {
    const detail = seedError instanceof Error ? seedError.message : String(seedError);
    let restored = false;
    await fence.write("finalization", () => store.updateTaskAtomic(task.id, (live) => {
      if (live.mergeDetails?.mergeConfirmed !== false
        || live.mergeDetails.reconciliation?.recordedSha !== recordedSha) return null;
      restored = true;
      const { reconciliation: _dropReconciliation, ...restDetails } = live.mergeDetails;
      return {
        mergeDetails: {
          ...restDetails,
          mergeConfirmed: true,
          commitSha: recordedSha,
          mergeConfirmationReconcileCount: Math.max(0, (live.mergeDetails.mergeConfirmationReconcileCount ?? 1) - 1),
        },
      };
    })).catch(() => undefined);
    await fence.write("log", () => store.logEntry(
      task.id,
      restored
        ? `Auto-recovery: merge re-open seeding failed (${detail}); landing confirmation restored and the recorded SHA will be re-proven on the next sweep.`
        : `Auto-recovery: merge re-open seeding failed (${detail}); the confirmation stays cleared — rerun recovery or retry the stage manually.`,
    )).catch(() => undefined);
    return { outcome: "skipped", reason: "reseed-failed-compensated" };
  }

  await fence.write("log", () => store.logEntry(task.id, `Auto-recovery: recorded landing SHA was never on ${branch}; merge re-opened`));
  await audit("reopened", previousAttempts + 1);
  return { outcome: "reopened" };
}
