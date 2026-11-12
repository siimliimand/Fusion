/**
 * FNXC:SpecLockDispatchBreaker 2026-11-12-08:04:
 * Graph-entry circuit breaker for deterministic spec-lock parser rejections.
 *
 * Measured on a real card (KB-001, 2026-11-05 → 2026-11-12): a plan review whose approval was
 * invalidated by `Plan approved but spec lock unavailable: mission-missing` re-ran the FULL
 * reviewer session every few minutes for days (~141M cumulative tokens) because no dispatch
 * boundary owned the rule that already existed in prose — "Never spend another reviewer call on
 * unchanged parser input" (pre-merge-gate-reseed.ts). The remediation and failed-step-recovery
 * seams both decline correctly, but the executor's plain graph re-entry path re-ran the gate
 * anyway, and self-healing reclaim kept resurrecting the parked card.
 *
 * This breaker is the invariant, enforced once at graph entry where PROMPT.md is readable: if the
 * latest plan-review failure is a deterministic parser rejection whose stamped input hash equals
 * the live prompt's hash, entering the graph can only repeat the identical failure, so the entry
 * is refused with zero reviewer dispatch. Changing PROMPT.md (planner replan or operator edit)
 * changes the hash, the breaker goes inert, and the next review runs normally.
 */
import type { Task, WorkflowStepResult } from "@fusion/core";
import {
  computePlanLockSourceHash,
  PLAN_REVIEW_GROUP_ID,
  planEvidenceBindingsFromTask,
  planLockInputHashFromDiagnostic,
} from "@fusion/core";
import { isUnavailablePlanLockResult } from "../merge/pre-merge-gate-reseed.js";

function isPlanReviewResult(result: Pick<WorkflowStepResult, "workflowStepId" | "workflowStepName" | "reviewKind">): boolean {
  return result.workflowStepId === PLAN_REVIEW_GROUP_ID
    || result.reviewKind === "plan"
    || result.workflowStepName === "Plan Review";
}

/**
 * The latest durable plan-review result that is a deterministic parser rejection: failed, no
 * reviewer verdict, and carrying the `Plan approved but spec lock unavailable:` diagnostic.
 * A REVISE verdict or a non-plan step never qualifies.
 */
export function findUnavailablePlanLockRejection(
  task: Pick<Task, "workflowStepResults">,
): WorkflowStepResult | undefined {
  return (task.workflowStepResults ?? []).find((result) =>
    (result.phase ?? "pre-merge") === "pre-merge"
    && result.status === "failed"
    && result.verdict === undefined
    && isPlanReviewResult(result)
    && isUnavailablePlanLockResult(result));
}

/**
 * True only when no post-plan-review step has produced a terminal result yet, so the graph's next
 * action is necessarily the plan review. A card the operator advanced past the failed gate (or a
 * resumed implementation/code-review continuation) must never be blocked by this breaker.
 */
export function hasNoPostPlanReviewProgress(
  task: Pick<Task, "workflowStepResults">,
): boolean {
  return !(task.workflowStepResults ?? []).some((result) =>
    result.workflowStepId !== PLAN_REVIEW_GROUP_ID
    && (result.phase ?? "pre-merge") === "pre-merge"
    && (result.status === "passed" || result.status === "failed" || result.status === "advisory_failure" || result.status === "skipped"));
}

export type PlanLockDispatchBreakerOutcome =
  | { blocked: true; rejection: WorkflowStepResult; inputHash: string }
  | { blocked: false };

export function isPlanReviewBlockedByUnchangedPlanLockRejection(
  task: Pick<Task, "workflowStepResults">,
  promptSourceHash: string,
): PlanLockDispatchBreakerOutcome {
  const rejection = findUnavailablePlanLockRejection(task);
  if (!rejection) return { blocked: false };
  if (!hasNoPostPlanReviewProgress(task)) return { blocked: false };
  const stampedHash = planLockInputHashFromDiagnostic(rejection.output ?? rejection.notes);
  /* Legacy rows written before stamping have no comparable identity; stay inert rather than guess. */
  if (!stampedHash) return { blocked: false };
  if (stampedHash !== promptSourceHash) return { blocked: false };
  return { blocked: true, rejection, inputHash: stampedHash };
}

export type PlanLockDispatchBreakerDeps = {
  readTaskArtifact: (taskId: string, key: string) => Promise<string | undefined>;
};

/**
 * Resolve the breaker against the live PROMPT.md — the same artifact the spec-lock check itself
 * reads. Any resolution failure (missing artifact, store hiccup) leaves the breaker inert:
 * blocking graph entry on a breaker malfunction would trade a bounded loop for a wedge.
 */
export async function resolvePlanLockDispatchBreaker(
  deps: PlanLockDispatchBreakerDeps,
  task: Task,
): Promise<PlanLockDispatchBreakerOutcome> {
  let prompt: string | undefined;
  try {
    prompt = await deps.readTaskArtifact(task.id, "PROMPT.md");
  } catch {
    return { blocked: false };
  }
  if (!prompt?.trim()) return { blocked: false };
  const inputHash = computePlanLockSourceHash(prompt, planEvidenceBindingsFromTask(task));
  return isPlanReviewBlockedByUnchangedPlanLockRejection(task, inputHash);
}
