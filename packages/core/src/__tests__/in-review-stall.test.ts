import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  countRecentIdenticalStallEntries,
  DEFAULT_MAX_AUTO_MERGE_RETRIES,
  DEFAULT_STALE_MERGING_MIN_AGE_MS,
  getInReviewStallReason,
  IN_REVIEW_STALL_LOG_PREFIX,
  IN_REVIEW_STALL_SUPPRESSED_LOG_PREFIX,
} from "../tasks/in-review-stall.js";

const NOW = Date.parse("2026-05-12T12:00:00.000Z");

const baseTask = {
  id: "FN-4110",
  column: "in-review" as const,
  paused: false,
  status: undefined as string | undefined,
  error: undefined as string | undefined,
  steps: [{ name: "Step 1", status: "done" as const }],
  workflowStepResults: undefined,
  worktree: "/tmp/fn-4110",
  mergeDetails: {},
  mergeRetries: 0,
  updatedAt: new Date(NOW).toISOString(),
};

describe("classifyProviderError", () => {
  it.each([
    "HTTP 400 invalid_request_error: unsupported parameter",
    "model gpt-5.3-codex is not supported by this provider",
    "model claude-next not found",
    "Configured model provider/model was not found in the pi model registry",
    "invalid model: gpt-unknown",
    "The requested model does not exist",
    "permission denied for model access",
    "HTTP 403 forbidden for model",
    "401 unauthorized: invalid api key",
  ])("classifies non-retryable provider errors: %s", (message) => {
    expect(classifyProviderError(message)).toBe("non_retryable");
  });

  it.each([
    "HTTP 503 service unavailable",
    "429 rate limit exceeded",
    "Request timed out after 60s",
    "ECONNRESET while reading provider response",
    "provider overloaded; try again later",
  ])("classifies retryable provider errors: %s", (message) => {
    expect(classifyProviderError(message)).toBe("retryable");
  });

  it.each([
    "",
    "task has incomplete steps",
    "merge conflict in package.json",
    "unexpected provider response shape",
  ])("classifies unknown errors: %s", (message) => {
    expect(classifyProviderError(message)).toBe("unknown");
  });

  it("gives non-retryable patterns precedence over retryable patterns", () => {
    expect(classifyProviderError("HTTP 400 invalid_request_error after rate limit warning")).toBe("non_retryable");
  });
});

describe("countRecentIdenticalStallEntries", () => {
  const reason = "Failed to create worktree after 3 attempts";
  const task = (log: Array<{ timestamp: string; action: string }>) => ({ log });

  it("returns 0 with no log entries", () => {
    expect(countRecentIdenticalStallEntries(task([]), { code: "merge-blocker", reason })).toBe(0);
  });

  it("counts three identical most-recent entries", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:57:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
    ]), { code: "merge-blocker", reason })).toBe(3);
  });

  it("stops at first non-stall entry and only counts the suffix", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:56:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:57:00.000Z", action: "something else" },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
    ]), { code: "merge-blocker", reason })).toBe(2);
  });

  it("stops counting on different code", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:57:00.000Z", action: "In-review stall surfaced [merge-retries-exhausted]: retries exhausted" },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
    ]), { code: "merge-blocker", reason })).toBe(2);
  });

  it("stops counting on different reason text", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:57:00.000Z", action: "In-review stall surfaced [merge-blocker]: another reason" },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
    ]), { code: "merge-blocker", reason })).toBe(2);
  });

  /*
  KB-016 counter-hygiene pins: the capacity-suppression and merge-handoff re-drive markers are
  NON-surfaced entries, so the scan-break contract below (unchanged by KB-016) resets the
  consecutive identical-stall run the moment the underlying cause changes — a stale pre-recovery
  count can never dispose a card after recovery.
  */
  it("KB-016: the capacity-suppression marker breaks the identical-stall run", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:57:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: "In-review stall suppressed [capacity]: claimed=2/max=2" },
    ]), { code: "merge-blocker", reason })).toBe(0);
  });

  it("KB-016: the merge-handoff re-drive marker breaks the identical-stall run", () => {
    expect(countRecentIdenticalStallEntries(task([
      { timestamp: "2026-05-12T11:57:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:58:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-05-12T11:59:00.000Z", action: "Merge handoff re-driven [in-review stall]: some reason" },
    ]), { code: "merge-blocker", reason })).toBe(0);
  });

  it("KB-016: suppression and re-drive markers are never mistaken for surfaced-dedup entries", () => {
    // The sweep's surfaced-dedup backward find filters on IN_REVIEW_STALL_LOG_PREFIX; a marker that
    // prefix-matched it would let a wait marker silence a real stall (or vice versa).
    expect(IN_REVIEW_STALL_SUPPRESSED_LOG_PREFIX.startsWith(IN_REVIEW_STALL_LOG_PREFIX)).toBe(false);
    expect(IN_REVIEW_STALL_LOG_PREFIX.startsWith(IN_REVIEW_STALL_SUPPRESSED_LOG_PREFIX)).toBe(false);
    expect("Merge handoff re-driven [in-review stall]:".startsWith(IN_REVIEW_STALL_LOG_PREFIX)).toBe(false);
  });
});

describe("getInReviewStallReason", () => {
  it("returns transient-merge-status-no-owner for FN-4110 fixture", () => {
    const signal = getInReviewStallReason(
      {
        ...baseTask,
        status: "merging",
        mergeRetries: 0,
        worktree: "/tmp/fn-4110",
        updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
      },
      { now: NOW },
    );

    expect(signal?.code).toBe("transient-merge-status-no-owner");
  });

  it("returns undefined when active merger owns task", () => {
    expect(getInReviewStallReason({ ...baseTask, status: "merging" }, { now: NOW, activeMergeTaskId: "FN-4110" })).toBeUndefined();
  });

  it("returns undefined when task is currently executing", () => {
    expect(getInReviewStallReason({ ...baseTask, status: "merging" }, { now: NOW, executingTaskIds: new Set(["FN-4110"]) })).toBeUndefined();
  });

  it("returns merge-retries-exhausted", () => {
    const signal = getInReviewStallReason({ ...baseTask, mergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES, mergeDetails: { mergeConfirmed: false } }, { now: NOW });
    expect(signal?.code).toBe("merge-retries-exhausted");
  });

  it("surfaces a completed status-none merge handoff after the stale threshold", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: undefined,
      mergeRetries: 0,
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 1).toISOString(),
    }, { now: NOW });
    expect(signal?.code).toBe("completed-review-status-none");
  });

  it("does not surface status-none drift for incomplete or zero-step review tasks", () => {
    for (const steps of [[], [{ name: "Step 1", status: "pending" as const }]]) {
      expect(getInReviewStallReason({
        ...baseTask,
        steps,
        updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 1).toISOString(),
      }, { now: NOW })?.code).not.toBe("completed-review-status-none");
    }
  });

  it("returns no-worktree-no-merge-confirmed", () => {
    const signal = getInReviewStallReason({ ...baseTask, worktree: undefined, mergeDetails: {} }, { now: NOW });
    expect(signal?.code).toBe("no-worktree-no-merge-confirmed");
  });

  it("returns undefined for awaiting-user-review", () => {
    expect(getInReviewStallReason({ ...baseTask, status: "awaiting-user-review" }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for awaiting-approval", () => {
    expect(getInReviewStallReason({ ...baseTask, status: "awaiting-approval" }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for paused tasks", () => {
    expect(getInReviewStallReason({ ...baseTask, paused: true }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined when merge is confirmed", () => {
    expect(getInReviewStallReason({ ...baseTask, mergeDetails: { mergeConfirmed: true }, status: "merging" }, { now: NOW })).toBeUndefined();
  });

  it("returns merge-blocker for failed pre-merge workflow step", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      workflowStepResults: [{ workflowStepId: "WS-1", workflowStepName: "gate", status: "failed", phase: "pre-merge" as const }],
    }, { now: NOW });
    expect(signal?.code).toBe("merge-blocker");
    expect(signal?.reason).toContain("failed pre-merge workflow steps");
  });

  it("returns non-retryable-provider-error for failed task provider blockers", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "failed",
      error: "HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
    }, { now: NOW });
    expect(signal?.code).toBe("non-retryable-provider-error");
    expect(signal?.reason).toBe("Terminal provider error: HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported");
  });

  it("keeps retryable provider errors as merge-blockers", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "failed",
      error: "HTTP 503 service unavailable",
    }, { now: NOW });
    expect(signal?.code).toBe("merge-blocker");
    expect(signal?.reason).toBe("task is marked 'failed': HTTP 503 service unavailable");
  });

  it("keeps unknown failed task errors as merge-blockers", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "failed",
      error: "merge conflict requires manual resolution",
    }, { now: NOW });
    expect(signal?.code).toBe("merge-blocker");
    expect(signal?.reason).toBe("task is marked 'failed': merge conflict requires manual resolution");
  });

  it("suppresses merge-blocker when autoMerge is disabled", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      workflowStepResults: [{ workflowStepId: "WS-1", workflowStepName: "gate", status: "failed", phase: "pre-merge" as const }],
    }, { now: NOW, autoMerge: false });
    expect(signal).toBeUndefined();
  });

  it("suppresses transient-merge-status-no-owner when autoMerge is disabled", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
    }, { now: NOW, autoMerge: false });
    expect(signal).toBeUndefined();
  });

  it("suppresses merge-retries-exhausted when autoMerge is disabled", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      mergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES,
      mergeDetails: { mergeConfirmed: false },
    }, { now: NOW, autoMerge: false });
    expect(signal).toBeUndefined();
  });

  it("suppresses no-worktree-no-merge-confirmed when autoMerge is disabled", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      worktree: undefined,
      mergeDetails: {},
    }, { now: NOW, autoMerge: false });
    expect(signal).toBeUndefined();
  });

  it("preserves legacy behavior when autoMerge is true or omitted", () => {
    const stalledTask = {
      ...baseTask,
      mergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES,
      mergeDetails: { mergeConfirmed: false },
    };
    expect(getInReviewStallReason(stalledTask, { now: NOW, autoMerge: true })?.code).toBe("merge-retries-exhausted");
    expect(getInReviewStallReason(stalledTask, { now: NOW })?.code).toBe("merge-retries-exhausted");
  });

  it("returns undefined when all clear", () => {
    expect(getInReviewStallReason({ ...baseTask }, { now: NOW })).toBeUndefined();
  });

  it("preserves status-driven merge-blocker even when activation floor is recent", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
    }, {
      now: NOW,
      engineActiveSinceMs: NOW - (DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000),
      engineActivationGraceMs: 90_000,
    });
    expect(signal?.code).toBe("merge-blocker");
  });

  it("fires transient status once engine activation floor is old", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
    }, {
      now: NOW,
      engineActiveSinceMs: NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 120_000,
      engineActivationGraceMs: 0,
    });
    expect(signal?.code).toBe("transient-merge-status-no-owner");
  });

  it("with zero grace, counts from activation timestamp immediately", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 1).toISOString(),
    }, {
      now: NOW,
      engineActiveSinceMs: NOW,
      engineActivationGraceMs: 0,
    });
    expect(signal?.code).toBe("merge-blocker");
  });

  it("prioritizes transient merge status over retries exhausted", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      mergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES,
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
    }, { now: NOW });
    expect(signal?.code).toBe("transient-merge-status-no-owner");
  });
});

describe("getInReviewStallReason capacity suppression (KB-016)", () => {
  const saturatedCapacity = { claimed: 2, maxConcurrent: 2 };
  const freeCapacity = { claimed: 1, maxConcurrent: 2 };
  const staleCompletedReviewTask = {
    ...baseTask,
    status: undefined,
    updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 1).toISOString(),
  };

  it("marks completed-review-status-none as capacity-suppressed on a saturated board", () => {
    const signal = getInReviewStallReason({ ...staleCompletedReviewTask }, { now: NOW, capacity: saturatedCapacity });
    expect(signal?.code).toBe("completed-review-status-none");
    expect(signal?.suppressedByCapacity).toBe(true);
    expect(signal?.capacity).toEqual({ claimed: 2, maxConcurrent: 2 });
  });

  it("marks transient-merge-status-no-owner as capacity-suppressed on a saturated board", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      status: "merging",
      updatedAt: new Date(NOW - DEFAULT_STALE_MERGING_MIN_AGE_MS - 60_000).toISOString(),
    }, { now: NOW, capacity: saturatedCapacity });
    expect(signal?.code).toBe("transient-merge-status-no-owner");
    expect(signal?.suppressedByCapacity).toBe(true);
    expect(signal?.capacity).toEqual({ claimed: 2, maxConcurrent: 2 });
  });

  it("never capacity-suppresses merge-blocker, even saturated (real-defect fence)", () => {
    const signal = getInReviewStallReason({
      ...baseTask,
      workflowStepResults: [{ workflowStepId: "WS-1", workflowStepName: "gate", status: "failed", phase: "pre-merge" as const }],
    }, { now: NOW, capacity: saturatedCapacity });
    expect(signal?.code).toBe("merge-blocker");
    expect(signal?.suppressedByCapacity).toBeUndefined();
    expect(signal?.capacity).toBeUndefined();
  });

  it("never capacity-suppresses merge-retries-exhausted or non-retryable-provider-error, even saturated", () => {
    const exhausted = getInReviewStallReason(
      { ...baseTask, mergeRetries: DEFAULT_MAX_AUTO_MERGE_RETRIES, mergeDetails: { mergeConfirmed: false } },
      { now: NOW, capacity: saturatedCapacity },
    );
    expect(exhausted?.code).toBe("merge-retries-exhausted");
    expect(exhausted?.suppressedByCapacity).toBeUndefined();
    const terminal = getInReviewStallReason(
      { ...baseTask, status: "failed", error: "HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported" },
      { now: NOW, capacity: saturatedCapacity },
    );
    expect(terminal?.code).toBe("non-retryable-provider-error");
    expect(terminal?.suppressedByCapacity).toBeUndefined();
  });

  it("does not mark when a slot is free (claimed === maxConcurrent - 1)", () => {
    const signal = getInReviewStallReason({ ...staleCompletedReviewTask }, { now: NOW, capacity: freeCapacity });
    expect(signal?.code).toBe("completed-review-status-none");
    expect(signal?.suppressedByCapacity).toBeUndefined();
    expect(signal?.capacity).toBeUndefined();
  });

  it("stays byte-identical without a capacity context (no flag on the returned signal)", () => {
    const signal = getInReviewStallReason({ ...staleCompletedReviewTask }, { now: NOW });
    expect(signal).toEqual({
      code: "completed-review-status-none",
      reason: "Completed review task has no merge owner or status for >= 5 min",
      observedAt: new Date(NOW).toISOString(),
    });
  });

  it("marks saturated cards above the cap (claimed > maxConcurrent, cap lowered mid-flight)", () => {
    const signal = getInReviewStallReason({ ...staleCompletedReviewTask }, { now: NOW, capacity: { claimed: 5, maxConcurrent: 2 } });
    expect(signal?.code).toBe("completed-review-status-none");
    expect(signal?.suppressedByCapacity).toBe(true);
  });

  it("autoMerge: false still wins over saturation (existing gate, not capacity)", () => {
    const signal = getInReviewStallReason({ ...staleCompletedReviewTask }, { now: NOW, autoMerge: false, capacity: saturatedCapacity });
    expect(signal).toBeUndefined();
  });

  it("zero-step cards stay excluded from completed-review-status-none under saturation", () => {
    const signal = getInReviewStallReason(
      { ...staleCompletedReviewTask, steps: [] },
      { now: NOW, capacity: saturatedCapacity },
    );
    expect(signal?.code).not.toBe("completed-review-status-none");
    expect(signal?.suppressedByCapacity).toBeUndefined();
  });
});
