import { getTaskMergeBlocker, isFailedPreMergeStepsBlocker } from "../merge/task-merge.js";
import type { Task, TaskLogEntry } from "../types.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-14:40 (fleet — long-tail fallback arms):
DELIBERATE-LITERAL — the no-resolution fallback for the already-converted guard below.

A named set rather than an inline `=== "<id>"` arm. Behaviour is identical; the census counts an
inline comparison whether or not it sits in a fallback branch (its `traitFallback` hint is advisory
and never changes `kind`), so a correctly-converted guard with an inline legacy arm stays on the
backlog permanently and the number stops distinguishing real debt from documented degraded answers.
*/
const LEGACY_REVIEW_LANES: ReadonlySet<string> = new Set(["in-review"]);


/**
 * State-based in-review stall detection. This is complementary to FN-4168's
 * planned heuristic `stalledReview` signal.
 *
 * Returning a signal is diagnostic-only and does not trigger any mutation by
 * itself. Callers MUST NOT use this helper as an auto-completion signal.
 *
 * When `context.autoMerge === false`, the signal is unconditionally suppressed
 * because in-review tasks are expected to remain on the PR-based manual flow.
 */
export type InReviewStallCode =
  | "merge-blocker"
  | "transient-merge-status-no-owner"
  | "merge-retries-exhausted"
  | "completed-review-status-none"
  | "no-worktree-no-merge-confirmed"
  | "non-retryable-provider-error";

export type ProviderErrorClassification = "non_retryable" | "retryable" | "unknown";

/**
 * Capacity snapshot a caller supplies when it can observe board saturation.
 * Only the engine self-healing sweep computes this today; read-layer badge
 * hydration never knows the claimed count and omits it.
 */
export interface InReviewStallCapacity {
  claimed: number;
  maxConcurrent: number;
}

export interface InReviewStallSignal {
  reason: string;
  code: InReviewStallCode;
  observedAt: string;
  /*
  FNXC:InReviewStallCapacity 2026-11-06-09:20 (KB-016) / 2026-11-11-15:04 (KB-046):
  Set ONLY when the caller supplied `context.capacity`, the board is saturated, and the signal is
  capacity-suppressible: a waiting-for-a-slot code, OR (KB-046) a merge-blocker whose reason is
  EXACTLY the failed-pre-merge-workflow-step blocker. It is absent (never false) when no capacity
  context is supplied, so callers without the seam stay byte-identical. Merge-blocker reasons other
  than the failed-pre-merge-step sentence are NEVER marked — they keep surfacing and counting.
  */
  suppressedByCapacity?: boolean;
  capacity?: InReviewStallCapacity;
}

export interface InReviewStallContext {
  now?: number;
  autoMerge?: boolean;
  activeMergeTaskId?: string | null;
  executingTaskIds?: ReadonlySet<string>;
  staleMergingMinAgeMs?: number;
  maxAutoMergeRetries?: number;
  engineActiveSinceMs?: number;
  engineActivationGraceMs?: number;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-22:10 (the lane seam, MEMBERSHIP not one column):
  `reviewColumn` is `resolveLifecycleColumns().review` — the FIRST column carrying a review role. A
  board declaring a separate merge lane beside its human-review lane has TWO, and a card in the second
  read as not-in-review. This takes the SET.

  Optional, with today's behaviour preserved as the fallback, so a caller that does not pass it is
  byte-identical.
  */
  reviewColumns?: ReadonlySet<string>;
  /*
  FNXC:InReviewStallCapacity 2026-11-06-09:20 (KB-016) / 2026-11-11-15:04 (KB-046 — the starvation model):
  A stall is only evidence of deadlock if the card had room to move. Under a saturated board
  (claimed >= maxConcurrent) the two signals whose ONLY meaning is "the card wants a slot and has
  not got one" — completed-review-status-none (review finished, merge handoff cannot claim a slot)
  and transient-merge-status-no-owner (the merger cannot claim a slot) — are manufactured by the
  capacity cap, not by the card. KB-007 (2026-11-06, proj_67ae5a1eb06e4218) was auto-failed as an
  "In-review stall deadlock" on a 2/2 board and recovered instantly once an operator raised the
  cap, proving the card was healthy.

  KB-046 extends the exemption to ONE merge-blocker reason: the saturated-window sibling incident
  (same board/window as KB-007, 02:06) surfaced `merge-blocker: task has failed pre-merge workflow
  steps` on a card whose ONLY reason for not advancing was the saturated cap — the failed gate
  cannot re-run and the merge cannot proceed while no slot is free. That exact reason is now
  capacity-suppressed (see applyCapacitySuppression); the failed-pre-merge-step remediation sweep
  already owns re-triggering the failed gate once a slot frees, so no re-drive is added here.

  Every other merge-blocker reason and the remaining defect-evidence codes
  (merge-retries-exhausted, no-worktree-no-merge-confirmed, non-retryable-provider-error) are
  evidence of real defects and are NEVER capacity-suppressed.

  Optional, with today's behaviour preserved as the fallback, so a caller that does not pass it
  (read-layer badge hydration never knows the claimed count) is byte-identical. Only the engine
  self-healing sweep supplies capacity.
  */
  capacity?: InReviewStallCapacity;
}

/** Keep aligned with engine DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS. */
export const DEFAULT_STALE_MERGING_MIN_AGE_MS = 5 * 60_000;
/** Historical default for the configurable auto-merge conflict retry cap. */
export const DEFAULT_MAX_AUTO_MERGE_RETRIES = 3;
export const DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURE_RETRIES = 2;
export const DEFAULT_CONSECUTIVE_TOOL_FAILURE_RETRY_BACKOFF_MS = 2_000;
/*
FNXC:ExecutorToolFailureRetry 2026-08-06-14:56:
One terminal tool_error after an execute-family run cursor must qualify for the
existing bounded same-model recovery. Explicit thresholds, retry budgets, and
cursor ownership remain the operator-controlled safety fences.
*/
export const CONSECUTIVE_TOOL_FAILURE_RETRY_THRESHOLD = 1;

/**
 * FNXC:AutoMergeRetries 2026-06-17-04:20:
 * Every engine, self-healing, dashboard, and core display surface must resolve the same project setting with defensive fallback semantics. Invalid persisted values intentionally fall back to 3 so old configs and hand-edits preserve the prior hardcoded behavior.
 */
export function resolveMaxAutoMergeRetries(settings?: { maxAutoMergeRetries?: unknown } | null): number {
  const configured = Number(settings?.maxAutoMergeRetries);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_MAX_AUTO_MERGE_RETRIES;
}

/**
 * FNXC:ExecutorToolFailureRetry 2026-08-06-14:56:
 * Normalize project policy identically in engine and settings UI. Invalid or
 * undefined thresholds fall back to the first-error default; finite explicit
 * thresholds at or above one retain operator intent.
 */
function resolveNonNegativeInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && Math.floor(numeric) >= 0 ? Math.floor(numeric) : fallback;
}
export function resolveMaxConsecutiveToolFailureRetries(settings?: { executorToolFailureRetryCount?: unknown } | null): number {
  return resolveNonNegativeInteger(settings?.executorToolFailureRetryCount, DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURE_RETRIES);
}
export function resolveConsecutiveToolFailureRetryBackoffMs(settings?: { executorToolFailureRetryBackoffMs?: unknown } | null): number {
  return resolveNonNegativeInteger(settings?.executorToolFailureRetryBackoffMs, DEFAULT_CONSECUTIVE_TOOL_FAILURE_RETRY_BACKOFF_MS);
}
export function resolveConsecutiveToolFailureThreshold(settings?: { executorToolFailureThreshold?: unknown } | null): number {
  const numeric = Number(settings?.executorToolFailureThreshold);
  return Number.isFinite(numeric) && Math.floor(numeric) >= 1 ? Math.floor(numeric) : CONSECUTIVE_TOOL_FAILURE_RETRY_THRESHOLD;
}

export interface ExecutorEscalationTarget {
  enabled: boolean;
  provider?: string;
  modelId?: string;
  nodeId?: string;
}

/**
 * FNXC:ExecutorEscalation 2026-07-16-21:00:
 * Escalation remains opt-in and only accepts a complete model pair or a node target. Keeping this resolver in core makes engine and settings surfaces agree that incomplete targets silently preserve FN-7996 terminal behavior.
 */
export function resolveExecutorEscalationTarget(settings?: {
  executorModelEscalationEnabled?: unknown;
  executorEscalationProvider?: unknown;
  executorEscalationModelId?: unknown;
  executorEscalationNodeId?: unknown;
} | null): ExecutorEscalationTarget {
  const provider = typeof settings?.executorEscalationProvider === "string" ? settings.executorEscalationProvider.trim() : "";
  const modelId = typeof settings?.executorEscalationModelId === "string" ? settings.executorEscalationModelId.trim() : "";
  const nodeId = typeof settings?.executorEscalationNodeId === "string" ? settings.executorEscalationNodeId.trim() : "";
  const hasModelTarget = Boolean(provider && modelId);
  const hasNodeTarget = Boolean(nodeId);
  return {
    enabled: settings?.executorModelEscalationEnabled === true && (hasModelTarget || hasNodeTarget),
    ...(hasModelTarget ? { provider, modelId } : {}),
    ...(hasNodeTarget ? { nodeId } : {}),
  };
}

/** FNXC:ReviewConvergence 2026-08-22-05:42: a target is usable only with a complete provider/model pair, preventing half-configured recovery from claiming a rung. */
export function resolveReviewConvergenceEscalationTarget(settings?: {
  reviewConvergenceEscalationEnabled?: unknown;
  reviewConvergenceEscalationProvider?: unknown;
  reviewConvergenceEscalationModelId?: unknown;
} | null): ExecutorEscalationTarget {
  const provider = typeof settings?.reviewConvergenceEscalationProvider === "string" ? settings.reviewConvergenceEscalationProvider.trim() : "";
  const modelId = typeof settings?.reviewConvergenceEscalationModelId === "string" ? settings.reviewConvergenceEscalationModelId.trim() : "";
  return { enabled: settings?.reviewConvergenceEscalationEnabled === true && Boolean(provider && modelId), ...(provider && modelId ? { provider, modelId } : {}) };
}

export function resolveReviewArbitrationTarget(settings?: {
  reviewArbitrationEnabled?: unknown;
  reviewArbitrationProvider?: unknown;
  reviewArbitrationModelId?: unknown;
} | null): ExecutorEscalationTarget {
  const provider = typeof settings?.reviewArbitrationProvider === "string" ? settings.reviewArbitrationProvider.trim() : "";
  const modelId = typeof settings?.reviewArbitrationModelId === "string" ? settings.reviewArbitrationModelId.trim() : "";
  return { enabled: settings?.reviewArbitrationEnabled !== false && Boolean(provider && modelId), ...(provider && modelId ? { provider, modelId } : {}) };
}

export const IN_REVIEW_STALL_LOG_PREFIX = "In-review stall surfaced [";
export const IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX = "In-review stall auto-disposed [";
export const IN_REVIEW_STALL_TERMINAL_LOG_PREFIX = "In-review stall terminal disposed [";
/*
FNXC:InReviewStallCapacity 2026-11-06-09:20 (KB-016) / 2026-11-11-15:04 (KB-046): visible capacity-wait marker. Written by the
engine sweep in place of a surfaced entry for suppressed signals so the wait is observable, not
silent. It deliberately does NOT start with IN_REVIEW_STALL_LOG_PREFIX, so the
`countRecentIdenticalStallEntries` scan-break contract treats it as a non-stall entry and resets
the consecutive identical-stall run (the counter-hygiene mechanism).
*/
export const IN_REVIEW_STALL_SUPPRESSED_LOG_PREFIX = "In-review stall suppressed [";

/*
FNXC:InReviewStallCapacity 2026-11-06-09:20 (KB-016) / 2026-11-11-15:04 (KB-046): the capacity-suppressible set.
Waiting-for-a-slot codes: every meaning of their signal is "the card wants a slot and has not got
one". KB-046 adds ONE merge-blocker exception: under saturation, a merge-blocker signal whose
reason is EXACTLY the failed-pre-merge-workflow-step blocker (`isFailedPreMergeStepsBlocker`) is
capacity-suppressed too — the card could not re-run its failed gate or merge because the board had
no free slot, so it visibly waits instead of accruing identical-stall counts toward disposal. Every
OTHER merge-blocker reason (incomplete steps, pending pre-merge result, marked status, and the
unreachable-through-this-classifier column-mismatch and unproven-approval families) plus the other
defect-evidence codes (merge-retries-exhausted, no-worktree-no-merge-confirmed,
non-retryable-provider-error) are evidence of real defects and stay surfaceable — and disposable —
regardless of board saturation.
*/
const CAPACITY_WAIT_STALL_CODES: ReadonlySet<InReviewStallCode> = new Set([
  "completed-review-status-none",
  "transient-merge-status-no-owner",
]);

function applyCapacitySuppression(
  signal: InReviewStallSignal,
  context: InReviewStallContext,
): InReviewStallSignal {
  const capacity = context.capacity;
  /*
  FNXC:InReviewStallCapacity 2026-11-11-15:04 (KB-046): the merge-blocker exemption gates on BOTH the code
  and the exact reason — a future arm producing the failed-pre-merge-step sentence under a different
  code must not silently suppress, and a merge-blocker reason that merely CONTAINS the words
  "failed" must never classify as this blocker (exact equality only).
  */
  const capacityWaitCode = CAPACITY_WAIT_STALL_CODES.has(signal.code);
  const failedPreMergeSteps = signal.code === "merge-blocker" && isFailedPreMergeStepsBlocker(signal.reason);
  if (!capacity || (!capacityWaitCode && !failedPreMergeSteps)) return signal;
  if (!(capacity.claimed >= capacity.maxConcurrent)) return signal;
  return {
    ...signal,
    suppressedByCapacity: true,
    capacity: { claimed: capacity.claimed, maxConcurrent: capacity.maxConcurrent },
  };
}

const TRANSIENT_MERGE_STATUSES = new Set(["merging", "merging-pr", "merging-fix"]);
const FAILED_TASK_MERGE_BLOCKER_PREFIX = "task is marked 'failed':";

export function classifyProviderError(error: string): ProviderErrorClassification {
  const normalized = error.trim().toLowerCase();
  if (!normalized) return "unknown";

  if (
    (/\b400\b/.test(normalized) && normalized.includes("invalid_request_error"))
    || /model\b.*\bis not supported/.test(normalized)
    || /model\b.*\bnot found/.test(normalized)
    || normalized.includes("was not found in the pi model registry")
    || normalized.includes("invalid model")
    || normalized.includes("model does not exist")
    || (/\b401\b/.test(normalized) && normalized.includes("unauthorized"))
    || (/\b403\b/.test(normalized) && normalized.includes("forbidden"))
    || (/permission denied/.test(normalized) && /model|access/.test(normalized))
  ) {
    return "non_retryable";
  }

  if (
    /\b429\b/.test(normalized)
    || normalized.includes("too many requests")
    || normalized.includes("rate limit")
    || /\b5\d\d\b/.test(normalized)
    || normalized.includes("overloaded")
    || normalized.includes("econnreset")
    || normalized.includes("etimedout")
    || normalized.includes("timed out")
    || normalized.includes("timeout")
  ) {
    return "retryable";
  }

  return "unknown";
}

export function countRecentIdenticalStallEntries(
  task: Pick<Task, "log">,
  signal: Pick<InReviewStallSignal, "code" | "reason">,
): number {
  const trimmedReason = signal.reason.trim();
  const reversed = [...(task.log ?? [])].reverse();
  let count = 0;

  for (const entry of reversed) {
    if (!entry.action.startsWith(IN_REVIEW_STALL_LOG_PREFIX)) {
      break;
    }
    if (!matchesStallEntry(entry, signal.code, trimmedReason)) {
      break;
    }
    count += 1;
  }

  return count;
}

function matchesStallEntry(entry: TaskLogEntry, code: InReviewStallCode, reason: string): boolean {
  const prefix = `${IN_REVIEW_STALL_LOG_PREFIX}${code}]:`;
  if (!entry.action.startsWith(prefix)) return false;
  const rawReason = entry.action.slice(prefix.length).trim();
  return rawReason === reason;
}

export function getInReviewStallReason(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults" | "worktree" | "mergeDetails" | "mergeRetries" | "updatedAt"> & { id?: string },
  context: InReviewStallContext = {},
): InReviewStallSignal | undefined {
  /*
  This classifier had NO seam while its two siblings did, so one decorated row could have
  `inReviewStalled` resolved and `inReviewStall` literal — one row, two lane answers.
  */
  const inReviewLane = (context.reviewColumns ?? LEGACY_REVIEW_LANES).has(task.column);
  if (!inReviewLane || task.paused === true) {
    return undefined;
  }

  if (context.autoMerge === false) {
    return undefined;
  }

  const now = context.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const staleMergingMinAgeMs = context.staleMergingMinAgeMs ?? DEFAULT_STALE_MERGING_MIN_AGE_MS;
  const maxAutoMergeRetries = resolveMaxAutoMergeRetries(context);

  if (task.mergeDetails?.mergeConfirmed === true) {
    return undefined;
  }

  if (task.id && (context.activeMergeTaskId === task.id || context.executingTaskIds?.has(task.id))) {
    return undefined;
  }

  if (task.status === "awaiting-user-review" || task.status === "awaiting-approval") {
    return undefined;
  }

  if (task.status && TRANSIENT_MERGE_STATUSES.has(task.status)) {
    const updatedAtMs = Date.parse(task.updatedAt);
    const activationFloorMs = getActivationFloorMs(context);
    const effectiveUpdatedAtMs = Number.isFinite(updatedAtMs)
      ? activationFloorMs !== undefined ? Math.max(updatedAtMs, activationFloorMs) : updatedAtMs
      : Number.NaN;
    if (Number.isFinite(effectiveUpdatedAtMs) && Math.max(0, now - effectiveUpdatedAtMs) >= staleMergingMinAgeMs) {
      const minutes = Math.max(1, Math.floor(staleMergingMinAgeMs / 60_000));
      return applyCapacitySuppression(
        {
          code: "transient-merge-status-no-owner",
          reason: `In transient '${task.status}' state with no active merger for >= ${minutes} min`,
          observedAt,
        },
        context,
      );
    }
  }

  const mergeRetries = task.mergeRetries ?? 0;
  if (mergeRetries >= maxAutoMergeRetries) {
    return {
      code: "merge-retries-exhausted",
      reason: `Auto-merge retries exhausted (${mergeRetries}/${maxAutoMergeRetries}) without confirmed merge`,
      observedAt,
    };
  }

  /*
  FNXC:MergeRetryAdmission 2026-09-20-02:17:
  A fully completed review card with no status, active owner, admitted retry, or
  terminal error is not an idle healthy state. Wait for the existing stale-merge
  threshold so a normal handoff is not badged, then expose the board/engine
  disagreement through the shared hydration signal rather than a dashboard-only
  inference. Zero-step cards remain excluded because they do not prove execution.
  */
  const updatedAtMs = Date.parse(task.updatedAt);
  const completedSteps = task.steps.length > 0
    && task.steps.every((step) => step.status === "done" || step.status === "skipped");
  if (
    completedSteps
    && task.status == null
    && !task.error
    && mergeRetries === 0
    && Number.isFinite(updatedAtMs)
    && Math.max(0, now - updatedAtMs) >= staleMergingMinAgeMs
  ) {
    const minutes = Math.max(1, Math.floor(staleMergingMinAgeMs / 60_000));
    /*
    FNXC:InReviewStallCapacity 2026-11-06-09:20 (KB-016): the KB-007 shape. On a saturated board
    this signal's only content is "the merge handoff cannot claim a slot" — the sweep marks it
    capacity-suppressed instead of counting it toward the 3-identical-stall deadlock disposal,
    and re-drives the handoff itself once capacity frees.
    */
    return applyCapacitySuppression(
      {
        code: "completed-review-status-none",
        reason: `Completed review task has no merge owner or status for >= ${minutes} min`,
        observedAt,
      },
      context,
    );
  }

  if (!task.worktree && task.mergeDetails?.noOpMerge !== true) {
    return {
      code: "no-worktree-no-merge-confirmed",
      reason: "No worktree on disk and merge not confirmed",
      observedAt,
    };
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:05 (this reported EVERY healthy review card as stalled):
  Forward the resolved lanes. This function had already satisfied its OWN lane check above using
  `context.reviewColumns`, then called getTaskMergeBlocker without them — so the helper re-ran its
  identity check against the literal `in-review` and, on a renamed board, returned
  `task is in 'signoff', must be in 'in-review'` for a perfectly healthy card.

  That string was then surfaced as `{ code: "merge-blocker" }`, i.e. a stall reason naming a column
  the board does not have — for every card in review. Worse than silence: the operator gets a wall of
  false stalls, each citing a lane that does not exist.

  The outer question was resolved and the inner one was not — the same half-conversion recorded at the
  helper itself for moves.ts, and fixed in #2963/#2964 for the merge paths.
  */
  const mergeBlocker = getTaskMergeBlocker(task, { reviewColumns: context.reviewColumns });
  if (mergeBlocker) {
    if (mergeBlocker.startsWith(FAILED_TASK_MERGE_BLOCKER_PREFIX)) {
      const error = mergeBlocker.slice(FAILED_TASK_MERGE_BLOCKER_PREFIX.length).trim();
      if (classifyProviderError(error) === "non_retryable") {
        return {
          code: "non-retryable-provider-error",
          reason: `Terminal provider error: ${error}`,
          observedAt,
        };
      }
    }

    /*
    FNXC:InReviewStallCapacity 2026-11-11-15:04 (KB-046): the merge-blocker arm flows through the
    suppression decision too. Exact-equality inside `applyCapacitySuppression` means only the
    failed-pre-merge-step sentence can come back marked under saturation; every other
    `getTaskMergeBlocker` sentence (and the non-retryable-provider-error diversion above, which is
    a different code by the time it reaches here) passes through byte-identical.
    */
    return applyCapacitySuppression({
      code: "merge-blocker",
      reason: mergeBlocker,
      observedAt,
    }, context);
  }

  return undefined;
}

function getActivationFloorMs(context: InReviewStallContext): number | undefined {
  if (typeof context.engineActiveSinceMs !== "number" || !Number.isFinite(context.engineActiveSinceMs)) {
    return undefined;
  }

  return context.engineActiveSinceMs + Math.max(0, context.engineActivationGraceMs ?? 0);
}
