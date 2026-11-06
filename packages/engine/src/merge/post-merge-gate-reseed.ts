import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  computeWorkflowIrPin,
  getPostMergeFinalizeBlocker,
  getRequiredPostMergeEvidenceDecision,
  resolveWorkflowIrForTaskWithProvenance,
  type TaskStore,
  type WorkflowStepResult,
  type RequiredPostMergeEvidenceDecision,
  type Task,
  type WorkflowWorkItemState,
} from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { createMergeWriteFence, type MergeWriteFence } from "./merge-write-fence.js";
import { isMergeActiveStatus } from "./merge-active-status.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";

/**
 * FNXC:PostMergeRecovery 2026-10-01-06:55:
 * A landed card with an absent post-merge gate must resume at that gate, not repeatedly try to
 * finalize or rerun implementation/merge. Existing results (including REVISE) remain authoritative
 * until a real recheck reports; scheduling work never grants approval or erases a rejection.
 * A fresh durable checkout lease is live ownership even when this process has no active session, so
 * finalization and self-healing must refuse it before the snapshot-fenced idle insert.
 */
const DEFAULT_CHECKOUT_LEASE_GRACE_MS = 10 * 60_000;
const CHECKOUT_LEASE_STALENESS_MULTIPLIER = 3;

/*
FNXC:RetryRefusalReasons 2026-11-04-10:05 (FIX-4, SUBC-008):
Single construction point for the refused outcome, so every fail-closed return below carries its
guard's machine reason instead of collapsing back into an unexplained boolean.
*/
function notResumable(
  reason: PostMergeGateResumeBlockReason,
  workItem?: PostMergeGateResumeBlockedWorkItem,
): PostMergeGateResumeResult {
  return workItem === undefined ? { outcome: "not-resumable", reason } : { outcome: "not-resumable", reason, workItem };
}

function firstActiveWorkItem(items: Array<Pick<PostMergeGateResumeBlockedWorkItem, "id" | "kind" | "state">>): PostMergeGateResumeBlockedWorkItem | undefined {
  const active = items.find((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state as WorkflowWorkItemState));
  return active ? { id: active.id ?? null, kind: active.kind, state: active.state } : undefined;
}

/**
 * FNXC:PostMergeRecovery 2026-10-01-06:55:
 * A fresh durable checkout lease is live ownership even when this process has no active session.
 * Exported for merge-confirmation reconciliation (FIX-2) so both recovery lanes share one lease
 * definition and cannot drift open.
 */
export function hasFreshCheckoutLease(
  task: { checkoutRunId?: string | null; checkoutLeaseRenewedAt?: string | null },
  settings: { taskStuckTimeoutMs?: number },
): boolean {
  const leaseAge = task.checkoutLeaseRenewedAt
    ? Date.now() - Date.parse(task.checkoutLeaseRenewedAt)
    : Number.POSITIVE_INFINITY;
  const graceMs = (settings.taskStuckTimeoutMs ?? DEFAULT_CHECKOUT_LEASE_GRACE_MS)
    * CHECKOUT_LEASE_STALENESS_MULTIPLIER;
  return !!task.checkoutRunId && Number.isFinite(leaseAge) && leaseAge >= 0 && leaseAge < graceMs;
}

export type PostMergeGateResumeResult =
  | { outcome: "resumed"; gateId: string }
  | { outcome: "not-resumable"; reason: PostMergeGateResumeBlockReason; workItem?: PostMergeGateResumeBlockedWorkItem };

/*
FNXC:RetryRefusalReasons 2026-11-04-10:05 (FIX-4, SUBC-008):
Every fail-closed guard below used to collapse into one boolean, so the operator Retry door answered
a single hard-coded conflict no matter which guard refused — during the incident the real blocker
was an orphaned work item, and the message blamed the gate instead. This union names each guard so
callers (the dashboard Retry route) can tell the operator the truth. The union is closed on purpose:
new guards must map onto the closest existing reason or extend it deliberately, never silently reuse
"not-due". `workItem` carries the one active item that blocks reseeding when `reason` is
"active-work-items" (ids/enums only).
*/
export type PostMergeGateResumeBlockReason =
  | "merge-active"
  | "lease-fresh"
  | "execution-live"
  | "finalize-blocker"
  | "active-work-items"
  | "workflow-selection-changed"
  | "not-due";

export type PostMergeGateRetryOutcome = "deferred" | "refused";

/*
FNXC:RetryOutcomeClassification 2026-11-05-21:38 (KB-007, SUBC-008):
An operator Retry must machine-readably distinguish a deferred retry from a refused one instead of
answering every failure with one undifferentiated 409. deferred means a later retry CAN act once
automatic progress clears the guard (merge-active, lease-fresh, execution-live, active-work-items);
refused means NO retry will act until something outside retry changes (finalize-blocker,
workflow-selection-changed, not-due). The lookup is keyed by the closed union so adding a new
reason fails compilation until it is classified deliberately — the same closed-union discipline the
reason union itself documents.
*/
const RETRY_OUTCOME_BY_BLOCK_REASON: Record<PostMergeGateResumeBlockReason, PostMergeGateRetryOutcome> = {
  "merge-active": "deferred",
  "lease-fresh": "deferred",
  "execution-live": "deferred",
  "active-work-items": "deferred",
  "finalize-blocker": "refused",
  "workflow-selection-changed": "refused",
  "not-due": "refused",
};

export function classifyPostMergeGateRetryOutcome(reason: PostMergeGateResumeBlockReason): PostMergeGateRetryOutcome {
  return RETRY_OUTCOME_BY_BLOCK_REASON[reason];
}

export interface PostMergeGateResumeBlockedWorkItem {
  id: string | null;
  kind: string;
  state: string;
}

const EXHAUSTED_PREFIX = "Post-merge verification needs remediation";

function hasLegacyRecoveryFailure(task: Pick<Task, "status" | "error">): boolean {
  return task.status === "failed" && task.error?.startsWith(`${EXHAUSTED_PREFIX}:`) === true;
}

/*
FNXC:ReviewRecovery 2026-10-04-02:24:
Post-merge reviewers can run before hosted CI finishes. Revisit rejected evidence after 15 minutes,
then 30 and 60 minutes, with further checks capped at one per hour. CI and follow-up fixes can
arrive after the early retries; a total attempt cap would strand their evidence permanently.
Durable result history survives restart and task-log updates cannot shorten the wait. Missing
timestamps, duplicate evidence and live owners fail closed.
*/
function isRejectedGateRecheckDue(result: WorkflowStepResult): boolean {
  const failures = (result.priorAttempts ?? []).filter((entry) => entry.status === "failed").length;
  const completedAt = Date.parse(result.completedAt ?? "");
  return result.status === "failed" && Number.isFinite(completedAt)
    && Date.now() - completedAt >= 15 * 60_000 * 2 ** Math.min(failures, 2);
}

export function isPostMergeGateRecoveryDue(
  task: Pick<Task, "workflowStepResults" | "status" | "error">,
  decision: RequiredPostMergeEvidenceDecision,
): boolean {
  if (hasLegacyRecoveryFailure(task)) return true;
  if (decision.outcome === "resumable") return true;
  if (decision.outcome !== "blocked" || decision.reason !== "failed") return false;
  const result = task.workflowStepResults?.find((entry) => entry.workflowStepId === decision.gateId);
  return !!result && isRejectedGateRecheckDue(result);
}

export async function resumeMissingPostMergeGate(
  store: TaskStore,
  taskId: string,
  options: { manualRetry?: boolean; fence?: MergeWriteFence } = {},
): Promise<PostMergeGateResumeResult> {
  const fence = options.fence ?? createMergeWriteFence({ taskId });
  if (typeof store.seedWorkspaceCodeReviewContinuationIfIdle !== "function") return notResumable("not-due");
  let task: Task = await store.getTask(taskId);
  const settings = await store.getSettings();
  /*
  FNXC:PostMergeCloseout 2026-10-12-14:59:
  Auto-merge authorization controls whether Fusion may land work; it must not suppress the
  graph-owned verification of a landing already proven durable. This recovery seeds only the
  existing post-merge evidence node and retains pause, ownership, proof, and result-state fences.
  */
  /*
  FNXC:RetryRefusalReasons 2026-11-04-10:05 (FIX-4, SUBC-008):
  The guards keep their original order and semantics; they are decomposed only so the refused
  outcome names the guard that actually fired. A finalize blocker caused by a merge-active status
  reports "merge-active" — that guard and the route's own live-merge refusal share one definition
  via isMergeActiveStatus, so the operator never gets two names for one condition.
  */
  if (!task.mergeDetails?.mergeConfirmed || !task.updatedAt) return notResumable("not-due");
  if (task.paused || task.userPaused || task.deletedAt) return notResumable("not-due");
  if (settings.globalPause || settings.enginePaused) return notResumable("not-due");
  if (getPostMergeFinalizeBlocker(task)) {
    return notResumable(isMergeActiveStatus(task.status) ? "merge-active" : "finalize-blocker");
  }
  if (hasFreshCheckoutLease(task, settings)) return notResumable("lease-fresh");
  if (isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock })) return notResumable("execution-live");

  if (hasLegacyRecoveryFailure(task)) {
    // Old recovery marked waiting reviews failed. Clear only its owned diagnostic;
    // the gate result and completion timestamp still govern approval and retry timing.
    const snapshot = task;
    let cleared = false;
    let clearRefusal: PostMergeGateResumeResult = notResumable("not-due");
    const updated = await fence.write("finalization", () => store.updateTaskAtomic(task.id, async (live) => {
      if (live.updatedAt !== snapshot.updatedAt || live.column !== snapshot.column
        || live.status !== snapshot.status || live.error !== snapshot.error) { clearRefusal = notResumable("not-due"); return null; }
      if (live.paused || live.userPaused || live.deletedAt) { clearRefusal = notResumable("not-due"); return null; }
      if (!live.mergeDetails?.mergeConfirmed) { clearRefusal = notResumable("not-due"); return null; }
      if (hasFreshCheckoutLease(live, settings)) { clearRefusal = notResumable("lease-fresh"); return null; }
      if (isTaskExecutionLive(live.id, { activeSessionRegistry, executingTaskLock })) { clearRefusal = notResumable("execution-live"); return null; }
      const items = await store.listWorkflowWorkItemsForTask(task.id);
      const activeItem = firstActiveWorkItem(items);
      if (activeItem) { clearRefusal = notResumable("active-work-items", activeItem); return null; }
      fence.assertOwned("finalization");
      cleared = true;
      return { status: null as unknown as Task["status"], error: null as unknown as Task["error"] };
    }, undefined, () => !fence.isOrphaned(), {
      expectedUpdatedAt: snapshot.updatedAt,
      expectedCheckedOutBy: snapshot.checkedOutBy ?? null,
      expectedCheckoutNodeId: snapshot.checkoutNodeId ?? null,
      expectedCheckoutLeaseEpoch: snapshot.checkoutLeaseEpoch ?? 0,
    }));
    if (!cleared || !updated || updated.status != null || updated.error != null) return clearRefusal;
    task = updated;
  }

  const decision = await getRequiredPostMergeEvidenceDecision(store, task);
  const manualRetry = options.manualRetry === true && decision.outcome === "blocked" && decision.reason === "failed";
  /*
  FNXC:RetryRefusalReasons 2026-11-04-10:05 (FIX-4, SUBC-008):
  "not-due" is deliberately the reason for both arms: an approved (or absent) gate and a
  backoff-gated rejection both mean "nothing is due for recheck right now". An operator Retry with a
  failed gate never reaches this line — manualRetry bypasses the backoff — so this reason reaches the
  dashboard only for the approved/pending gate shapes.
  */
  if (decision.outcome === "finalizable" || (!manualRetry && !isPostMergeGateRecoveryDue(task, decision))) return notResumable("not-due");
  const selection = await store.getTaskWorkflowSelectionAsync(task.id);
  const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
  if (resolved.source === "default" && !resolved.selectionAbsent) return notResumable("workflow-selection-changed");
  const { ir } = resolved;
  const node = ir.version === "v2" ? ir.nodes.find((candidate) => candidate.id === decision.gateId) : undefined;
  if (!node) return notResumable("workflow-selection-changed");

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const activeItem = firstActiveWorkItem(items);
  const seeded = await fence.write("finalization", () => store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:post-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection: selection ?? null,
    expectedTaskUpdatedAt: task.updatedAt,
  }));
  /*
  FNXC:RetryRefusalReasons 2026-11-04-10:05 (FIX-4, SUBC-008):
  The seeder's internal reasons are threaded, not collapsed. `active-continuation` maps to
  "active-work-items" with the pre-seed read's first active item as evidence (the seeder itself does
  not name the blocker on a bail); `task-state-changed` is a lost eligibility race, which is
  "not-due" for the caller — the next invocation re-derives everything.
  */
  if (!seeded?.seeded) {
    if (seeded?.reason === "active-continuation") return notResumable("active-work-items", activeItem);
    if (seeded?.reason === "workflow-selection-changed") return notResumable("workflow-selection-changed");
    return notResumable("not-due");
  }
  await fence.write("log", () => store.logEntry(task.id, `[post-merge] ${decision.outcome === "resumable" ? "Resuming missing verification" : "Rechecking rejected evidence"} at '${node.id}'; already-landed implementation and merge will not run again.`));
  return { outcome: "resumed", gateId: node.id };
}
