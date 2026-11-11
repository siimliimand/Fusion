import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countRecentIdenticalStallEntries, FAILED_PRE_MERGE_STEPS_BLOCKER, type Task, type TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const COMPLETED_REVIEW_REASON = "Completed review task has no merge owner or status for >= 5 min";
const SUPPRESSED_LOG_ACTION = "In-review stall suppressed [capacity]: claimed=2/max=2";
/** A retryable provider error so the marked-status fixture stays a merge-blocker (not non-retryable). */
const WORKTREE_CREATION_ERROR = "Failed to create worktree after 3 attempts: ENOENT";
const MARKED_STATUS_REASON = `task is marked 'failed': ${WORKTREE_CREATION_ERROR}`;

/**
 * KB-016 regression harness. Mirrors the in-review-stall-deadlock-disposition mock store:
 * EventEmitter + vi.fn store methods + fake timers, so the sweep runs end to end against an
 * in-memory card and every audit event is captured for assertion.
 */
function createStore(task: Task, settings: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const auditEvents: any[] = [];

  (emitter as any).__auditEvents = auditEvents;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    inReviewStallDeadlockThreshold: 3,
    maxConcurrent: 2,
    ...settings,
  });
  (emitter as any).listTasks = vi.fn().mockImplementation(async () => [task]);
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date(Date.now()).toISOString(), action });
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    Object.assign(task, updates);
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    auditEvents.push(event);
  });
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).enqueueMergeQueue = vi.fn().mockResolvedValue(undefined);

  return emitter;
}

/**
 * The KB-007 incident shape: a healthy completed review card (all steps done, null status, no
 * error, zero merge retries, stale updatedAt) parked in the review lane with no merge owner.
 */
function completedReviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-007-CAP",
    column: "in-review",
    paused: false,
    userPaused: false,
    status: null,
    error: null,
    branch: "fusion/kb-007-cap",
    worktree: "/tmp/kb-007-cap",
    mergeDetails: {},
    mergeRetries: 0,
    steps: [{ name: "implement", status: "done" }],
    workflowStepResults: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    log: [],
    ...overrides,
  } as unknown as Task;
}

/** A live WIP card that occupies a top-level agent slot for the store-computed capacity path. */
function liveWipTask(id: string): Task {
  return {
    id,
    column: "in-progress",
    paused: false,
    userPaused: false,
    status: null,
    steps: [{ name: "implement", status: "in-progress" }],
    workflowStepResults: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    log: [],
  } as unknown as Task;
}

/*
The KB-046 saturated-window sibling shape (2026-11-06, proj_67ae5a1eb06e4218): a review card whose
ONLY merge blocker is a FAILED pre-merge workflow-step result. Arm-order dodges are deliberate and
load-bearing:
- `mergeRetries: 1` walks past BOTH the completed-review-status-none arm (requires retries === 0)
  and the merge-retries-exhausted arm (requires retries >= default max 3), so the classifier
  reaches the merge-blocker arm carrying this exact reason.
- `status: null` (NOT "failed"): a failed task STATUS produces the marked-status reason
  `task is marked 'failed': <error>` instead — a DIFFERENT reason that must keep counting (scenario E).
- Fresh `updatedAt` also dodges completed-review independently of the retries dodge; stale updatedAt
  here mirrors the incident card that had been waiting across multiple sweep windows.
*/
function failedPreMergeStepTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-046-CAP",
    column: "in-review",
    paused: false,
    userPaused: false,
    status: null,
    error: null,
    branch: "fusion/kb-046-cap",
    worktree: "/tmp/kb-046-cap",
    mergeDetails: {},
    mergeRetries: 1,
    steps: [{ name: "implement", status: "done" }],
    workflowStepResults: [{ workflowStepId: "WS-GATE", workflowStepName: "code-review", status: "failed", phase: "pre-merge" }],
    updatedAt: "2026-01-01T00:00:00.000Z",
    log: [],
    ...overrides,
  } as unknown as Task;
}

describe("reliability: in-review stall capacity exemption (KB-016)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("scenario 1: saturated board suppresses completed-review stalls with one deduplicated visible wait line and no disposal", async () => {
    const task = completedReviewTask();
    const store = createStore(task);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getConcurrencyCapacity: () => ({ claimed: 2, maxConcurrent: 2 }),
    });

    // Tick 1 — suppressed: exactly one visible wait line, zero surfaced entries, untouched card.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);

    expect(task.log).toHaveLength(1);
    expect(task.log![0].action).toBe(SUPPRESSED_LOG_ACTION);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall surfaced ["))).toBe(false);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall auto-disposed ["))).toBe(false);
    expect(task.paused).toBeFalsy();
    expect(task.status).toBeNull();
    expect((store.updateTask as any).mock.calls).toHaveLength(0);

    const auditEvents = (store as any).__auditEvents as any[];
    const suppressedEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-capacity-suppressed");
    expect(suppressedEvents).toHaveLength(1);
    expect(suppressedEvents[0]).toMatchObject({
      domain: "database",
      taskId: "KB-007-CAP",
      target: "KB-007-CAP",
      agentId: "self-healing",
      metadata: {
        taskId: "KB-007-CAP",
        code: "completed-review-status-none",
        claimed: 2,
        maxConcurrent: 2,
      },
    });

    // Ticks 2 and 3 (>= taskStuckTimeoutMs apart) — deduped: no second suppression line,
    // still no surfaced entry, still no disposal.
    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);

    expect(task.log).toHaveLength(1);
    expect((store.updateTask as any).mock.calls).toHaveLength(0);
    expect(auditEvents.filter((event) => event.mutationType === "task:in-review-stall-capacity-suppressed")).toHaveLength(1);
    expect(auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toHaveLength(0);

    // Counter hygiene: the suppression marker is a non-surfaced entry, so the identical-stall
    // run stays at zero — no stale count can ever dispose this card.
    expect(countRecentIdenticalStallEntries(task, {
      code: "completed-review-status-none",
      reason: COMPLETED_REVIEW_REASON,
    })).toBe(0);

    manager.stop();
  });

  it("scenario 1b: production path without the options seam computes saturation from the store and suppresses identically", async () => {
    const task = completedReviewTask();
    const store = createStore(task);
    // Two live WIP holders + the stalled card: the store-computed claimed count is 2 >= default
    // max 2, with NO injected seam — this guards the real computeTopLevelConcurrencyClaimedFromStore
    // wiring (and its fail-open contract by construction: these fixtures resolve, so capacity IS computed).
    const wipA = liveWipTask("KB-007-WIP-A");
    const wipB = liveWipTask("KB-007-WIP-B");
    (store as any).listTasks = vi.fn().mockResolvedValue([wipA, wipB, task]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);

    expect(task.log).toHaveLength(1);
    expect(task.log![0].action).toBe(SUPPRESSED_LOG_ACTION);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall surfaced ["))).toBe(false);
    expect(task.paused).toBeFalsy();
    expect((store.updateTask as any).mock.calls).toHaveLength(0);

    const auditEvents = (store as any).__auditEvents as any[];
    expect(auditEvents.filter((event) => event.mutationType === "task:in-review-stall-capacity-suppressed")).toHaveLength(1);
    expect(auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toHaveLength(0);

    expect(countRecentIdenticalStallEntries(task, {
      code: "completed-review-status-none",
      reason: COMPLETED_REVIEW_REASON,
    })).toBe(0);

    manager.stop();
  });

  it("scenario 2: free capacity re-drives the merge handoff once; disposal still fires after 3 post-re-drive identical stalls", async () => {
    const task = completedReviewTask();
    const store = createStore(task);
    const requeue = vi.fn();
    // NO capacity seam: single-card fixture so the store-computed claimed count is 0 < default
    // max 2 — this exercises the production capacity path end to end.
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo", requeueForAutoMerge: requeue });

    // Tick 1 — re-drive: handoff re-driven, marker logged, NO surfaced entry, NO disposal.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect((store.enqueueMergeQueue as any).mock.calls).toEqual([["KB-007-CAP"]]);
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(requeue).toHaveBeenCalledWith("KB-007-CAP");
    expect(task.log).toHaveLength(1);
    expect(task.log![0].action).toBe(`Merge handoff re-driven [in-review stall]: ${COMPLETED_REVIEW_REASON}`);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall surfaced ["))).toBe(false);
    expect(task.paused).toBeFalsy();
    expect((store.updateTask as any).mock.calls).toHaveLength(0);

    // Ticks 2-4 — surfaced entries accrue. Dedup-scan honesty: the log contains ONLY the re-drive
    // marker at tick 2, and the card still surfaces normally because the signal is real and
    // undeduped — the surfaced-dedup backward find filters on the surfaced prefix and never
    // matches the marker. The marker latch blocks further re-drives, so the identical-stall run
    // starts fresh AFTER the re-drive and reaches the preserved deadlock threshold.
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T00:16:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    // Tick 4 disposed exactly once with the unchanged deadlock disposition contract.
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.status).toBe("failed");
    const disposedEntries = task.log!.filter((entry) => entry.action.startsWith("In-review stall auto-disposed [completed-review-status-none]:"));
    expect(disposedEntries).toHaveLength(1);
    expect(disposedEntries[0].action).toContain("deadlock-prevention threshold reached after 3 identical stalls");
    expect((store.updateTask as any).mock.calls).toHaveLength(1);

    const auditEvents = (store as any).__auditEvents as any[];
    const disposeAuditEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed");
    expect(disposeAuditEvents).toHaveLength(1);

    // The handoff was re-driven exactly ONCE across the whole episode — no recurring re-drive can
    // mask a genuine deadlock.
    expect((store.enqueueMergeQueue as any).mock.calls).toHaveLength(1);
    expect(requeue).toHaveBeenCalledTimes(1);

    manager.stop();
  });

  it("scenario 2b: an explicitly rejected merge requeue is not 'given its chance' — the card still surfaces and counts toward disposal (FN-6070 contract)", async () => {
    const task = completedReviewTask();
    const store = createStore(task);
    const requeue = vi.fn(() => false);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo", requeueForAutoMerge: requeue });

    // Tick 1 — the requeue callback explicitly rejects, so NO re-drive marker is written and the
    // tick surfaces normally: the card is failing to advance WITH free capacity, the genuine
    // deadlock shape disposal is reserved for.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(requeue).toHaveBeenCalledTimes(1);
    expect((store.enqueueMergeQueue as any).mock.calls).toEqual([["KB-007-CAP"]]);
    expect(task.log!.some((entry) => entry.action.startsWith("Merge handoff re-driven ["))).toBe(false);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall surfaced ["))).toBe(true);

    // Ticks 2-3 — identical stalls accrue; tick 3 disposes (fence intact for a genuinely stuck card).
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.status).toBe("failed");
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall auto-disposed [completed-review-status-none]:"))).toBe(true);

    manager.stop();
  });

  it("scenario 3: capacity freeing mid-window resets the stall cause and proceeds with the handoff, never disposing", async () => {
    const task = completedReviewTask();
    const store = createStore(task);
    const requeue = vi.fn();
    let capacity: { claimed: number; maxConcurrent: number } = { claimed: 2, maxConcurrent: 2 };
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getConcurrencyCapacity: () => capacity,
      requeueForAutoMerge: requeue,
    });

    // Tick 1 — saturated: the wait is visible, the counter is untouched.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(task.log).toHaveLength(1);
    expect(task.log![0].action).toBe(SUPPRESSED_LOG_ACTION);

    // Tick 2 — capacity freed: the signal fires unsuppressed, the handoff is re-driven, the card
    // gets its chance to advance.
    capacity = { claimed: 0, maxConcurrent: 2 };
    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect((store.enqueueMergeQueue as any).mock.calls).toEqual([["KB-007-CAP"]]);
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(requeue).toHaveBeenCalledWith("KB-007-CAP");

    // The wait history is [suppression marker, re-drive marker] in order, and the identical-stall
    // counter is 0 — stale pre-recovery counts cannot dispose the card after the cause change.
    expect(task.log!.map((entry) => entry.action)).toEqual([
      SUPPRESSED_LOG_ACTION,
      `Merge handoff re-driven [in-review stall]: ${COMPLETED_REVIEW_REASON}`,
    ]);
    expect(countRecentIdenticalStallEntries(task, {
      code: "completed-review-status-none",
      reason: COMPLETED_REVIEW_REASON,
    })).toBe(0);
    expect(task.paused).toBeFalsy();
    expect((store.updateTask as any).mock.calls).toHaveLength(0);

    const auditEvents = (store as any).__auditEvents as any[];
    expect(auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toHaveLength(0);

    manager.stop();
  });

  /*
  KB-016 fail-open fence: capacity UNKNOWN (computation throws or returns null) must suppress NO
  signal and re-drive nothing — the pre-KB-016 surfacing/disposal behavior is fully preserved. This
  branch is load-bearing: the capacity read runs INSIDE surfaceInReviewStalls, so a regression that
  drops its try/catch would let the throw escape to the sweep's outer catch, silently no-oping
  EVERY stall signal on the board every tick. (2026-11-06, code review.)
  */
  it("fail-open: a throwing capacity seam suppresses nothing — the card surfaces and is never re-driven", async () => {
    const task = completedReviewTask();
    const store = createStore(task);
    const requeue = vi.fn();
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getConcurrencyCapacity: () => {
        throw new Error("capacity read failed");
      },
      requeueForAutoMerge: requeue,
    });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    // Normal pre-KB-016 surfacing: one surfaced stall entry, no suppression line, no re-drive
    // (the re-drive needs a capacity snapshot proving a free slot — unknown capacity cannot).
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall surfaced ["))).toBe(true);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall suppressed ["))).toBe(false);
    expect(task.log!.some((entry) => entry.action.startsWith("Merge handoff re-driven ["))).toBe(false);
    expect((store.enqueueMergeQueue as any).mock.calls).toHaveLength(0);
    expect(requeue).not.toHaveBeenCalled();
    expect(task.paused).toBeFalsy();

    manager.stop();
  });

  it("fail-open: a throwing store-backed capacity read (production path) suppresses nothing", async () => {
    const task = completedReviewTask();
    const store = createStore(task);
    // The candidate read (column-shaped) succeeds; only the capacity read (slim-shaped) throws,
    // so the tick still reaches the card and fail-opens to normal surfacing.
    (store as any).listTasks = vi.fn().mockImplementation(async (options: { slim?: boolean } = {}) => {
      if (options.slim) throw new Error("slim read shard down");
      return [task];
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall surfaced ["))).toBe(true);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall suppressed ["))).toBe(false);
    expect(task.paused).toBeFalsy();

    manager.stop();
  });

  it("scenario 4: autoMerge:false under saturation leaves the card entirely untouched (human-review contract)", async () => {
    const task = completedReviewTask();
    const store = createStore(task, { autoMerge: false });
    const requeue = vi.fn();
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getConcurrencyCapacity: () => ({ claimed: 2, maxConcurrent: 2 }),
      requeueForAutoMerge: requeue,
    });

    for (const timestamp of ["2026-01-01T00:10:00.000Z", "2026-01-01T00:12:00.000Z", "2026-01-01T00:14:00.000Z"]) {
      vi.setSystemTime(new Date(timestamp));
      expect(await manager.surfaceInReviewStalls()).toBe(0);
    }

    // No log entries of any kind, no suppression line, no re-drive, no mutation: the existing
    // allowsAutoMergeProcessing guard runs BEFORE the signal and wins over capacity handling.
    expect(task.log ?? []).toHaveLength(0);
    expect((store.updateTask as any).mock.calls).toHaveLength(0);
    expect((store.enqueueMergeQueue as any).mock.calls).toHaveLength(0);
    expect(requeue).not.toHaveBeenCalled();
    expect(task.paused).toBeFalsy();
    expect(task.status).toBeNull();

    manager.stop();
  });

  it("scenario 4b: a per-task user auto-merge hold under saturation leaves the card entirely untouched", async () => {
    const task = completedReviewTask({ autoMerge: false, autoMergeProvenance: "user" } as Partial<Task>);
    const store = createStore(task, { autoMerge: true });
    const requeue = vi.fn();
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getConcurrencyCapacity: () => ({ claimed: 2, maxConcurrent: 2 }),
      requeueForAutoMerge: requeue,
    });

    for (const timestamp of ["2026-01-01T00:10:00.000Z", "2026-01-01T00:12:00.000Z", "2026-01-01T00:14:00.000Z"]) {
      vi.setSystemTime(new Date(timestamp));
      expect(await manager.surfaceInReviewStalls()).toBe(0);
    }

    expect(task.log ?? []).toHaveLength(0);
    expect((store.updateTask as any).mock.calls).toHaveLength(0);
    expect((store.enqueueMergeQueue as any).mock.calls).toHaveLength(0);
    expect(requeue).not.toHaveBeenCalled();

    manager.stop();
  });

  /*
  KB-046 scenario A — the incident reproduction. A saturated board (seam reports 2/2) with a card
  whose ONLY merge blocker is the exact failed-pre-merge-step reason: exactly ONE deduplicated
  visible wait line across multiple sweep ticks, no surfaced entry, no disposal write, and the
  bounded audit event carrying code "merge-blocker" with counts-only metadata. Pre-KB-046 this
  exact fixture accrued three identical surfaced entries and was auto-paused failed with
  `pausedReason: "in-review-stall-deadlock"` — the Symptom Verification's assertion-it-is-gone.
  */
  it("scenario A (KB-046): saturated board suppresses the failed-pre-merge-step merge-blocker with one deduplicated wait line and no disposal", async () => {
    const task = failedPreMergeStepTask();
    const store = createStore(task);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getConcurrencyCapacity: () => ({ claimed: 2, maxConcurrent: 2 }),
    });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);

    expect(task.log).toHaveLength(1);
    expect(task.log![0].action).toBe(SUPPRESSED_LOG_ACTION);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall surfaced ["))).toBe(false);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall auto-disposed ["))).toBe(false);
    expect(task.paused).toBeFalsy();
    expect(task.status).toBeNull();
    expect((store.updateTask as any).mock.calls).toHaveLength(0);

    const auditEvents = (store as any).__auditEvents as any[];
    const suppressedEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-capacity-suppressed");
    expect(suppressedEvents).toHaveLength(1);
    expect(suppressedEvents[0]).toMatchObject({
      domain: "database",
      taskId: "KB-046-CAP",
      target: "KB-046-CAP",
      agentId: "self-healing",
      metadata: {
        taskId: "KB-046-CAP",
        code: "merge-blocker",
        claimed: 2,
        maxConcurrent: 2,
      },
    });

    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);

    expect(task.log).toHaveLength(1);
    expect((store.updateTask as any).mock.calls).toHaveLength(0);
    expect(auditEvents.filter((event) => event.mutationType === "task:in-review-stall-capacity-suppressed")).toHaveLength(1);
    expect(auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toHaveLength(0);

    // Counter hygiene: the suppression marker broke the identical-stall run — the disposal counter
    // never accrued during the wait.
    expect(countRecentIdenticalStallEntries(task, {
      code: "merge-blocker",
      reason: FAILED_PRE_MERGE_STEPS_BLOCKER,
    })).toBe(0);

    manager.stop();
  });

  it("scenario B (KB-046): production path without the seam computes saturation from the store and suppresses identically", async () => {
    const task = failedPreMergeStepTask();
    const store = createStore(task);
    const wipA = liveWipTask("KB-046-WIP-A");
    const wipB = liveWipTask("KB-046-WIP-B");
    (store as any).listTasks = vi.fn().mockResolvedValue([wipA, wipB, task]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);

    expect(task.log).toHaveLength(1);
    expect(task.log![0].action).toBe(SUPPRESSED_LOG_ACTION);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall surfaced ["))).toBe(false);
    expect(task.paused).toBeFalsy();
    expect((store.updateTask as any).mock.calls).toHaveLength(0);

    const auditEvents = (store as any).__auditEvents as any[];
    const suppressedEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-capacity-suppressed");
    expect(suppressedEvents).toHaveLength(1);
    expect(suppressedEvents[0].metadata).toMatchObject({ code: "merge-blocker", claimed: 2, maxConcurrent: 2 });
    expect(auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toHaveLength(0);

    expect(countRecentIdenticalStallEntries(task, {
      code: "merge-blocker",
      reason: FAILED_PRE_MERGE_STEPS_BLOCKER,
    })).toBe(0);

    manager.stop();
  });

  /*
  KB-046 scenario C — the genuine-deadlock fence. The SAME failed-pre-merge-step card shape with a
  FREE slot still surfaces identically and disposes after the preserved 3-identical-stall threshold:
  capacity handling must never neuter real deadlock detection for this reason family.
  */
  it("scenario C (KB-046): free capacity keeps the failed-pre-merge-step merge-blocker surfacing and disposing after threshold", async () => {
    const task = failedPreMergeStepTask();
    const store = createStore(task);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getConcurrencyCapacity: () => ({ claimed: 1, maxConcurrent: 2 }),
    });

    // Ticks 1-2 — surfaced entries accrue normally (prior-identical counts 0 then 1).
    const surfaceAt = ["2026-01-01T00:10:00.000Z", "2026-01-01T00:12:00.000Z"];
    for (const timestamp of surfaceAt) {
      vi.setSystemTime(new Date(timestamp));
      expect(await manager.surfaceInReviewStalls()).toBe(1);
    }

    expect(task.paused).toBeFalsy();
    expect(task.log!.filter((entry) => entry.action.startsWith("In-review stall surfaced [merge-blocker]:"))).toHaveLength(2);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall suppressed ["))).toBe(false);

    // Tick 3 — 2 prior identical stalls + this tick = the preserved threshold of 3 → dispose once.
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.status).toBe("failed");
    const disposedEntries = task.log!.filter((entry) => entry.action.startsWith("In-review stall auto-disposed [merge-blocker]:"));
    expect(disposedEntries).toHaveLength(1);
    expect(disposedEntries[0].action).toContain("deadlock-prevention threshold reached after 3 identical stalls");
    expect(disposedEntries[0].action).toContain(FAILED_PRE_MERGE_STEPS_BLOCKER);
    expect((store.updateTask as any).mock.calls).toHaveLength(1);

    const auditEvents = (store as any).__auditEvents as any[];
    const disposeAuditEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed");
    expect(disposeAuditEvents).toHaveLength(1);
    expect(disposeAuditEvents[0].metadata).toMatchObject({ code: "merge-blocker", reason: FAILED_PRE_MERGE_STEPS_BLOCKER });

    manager.stop();
  });

  /*
  KB-046 scenario D — capacity frees mid-window: the suppression marker broke the identical-stall
  run, so surfaced entries accrue from ZERO after the slot frees and disposal only fires after the
  full post-free threshold. Pre-free wait time can never contribute to disposal.
  */
  it("scenario D (KB-046): capacity freeing mid-window resets the stall counter; disposal fires only from post-free counts", async () => {
    const task = failedPreMergeStepTask();
    const store = createStore(task);
    let capacity: { claimed: number; maxConcurrent: number } = { claimed: 2, maxConcurrent: 2 };
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getConcurrencyCapacity: () => capacity,
    });

    // Tick 1 — saturated: the wait is visible, the counter is untouched.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(task.log).toHaveLength(1);
    expect(task.log![0].action).toBe(SUPPRESSED_LOG_ACTION);

    // Capacity frees: surfaced entries accrue from zero — the marker is a non-surfaced entry, so
    // the pre-free wait contributed nothing to the counter.
    capacity = { claimed: 0, maxConcurrent: 2 };
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.log!.map((entry) => entry.action)).toEqual([
      SUPPRESSED_LOG_ACTION,
      `In-review stall surfaced [merge-blocker]: ${FAILED_PRE_MERGE_STEPS_BLOCKER}`,
      `In-review stall surfaced [merge-blocker]: ${FAILED_PRE_MERGE_STEPS_BLOCKER}`,
    ]);
    expect(task.paused).toBeFalsy();
    expect((store.updateTask as any).mock.calls).toHaveLength(0);

    // Disposal fires on the 3rd post-free stall tick (2 prior post-free surfaced + this tick) —
    // never earlier from pre-free counts.
    vi.setSystemTime(new Date("2026-01-01T00:16:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.status).toBe("failed");
    const disposedEntries = task.log!.filter((entry) => entry.action.startsWith("In-review stall auto-disposed [merge-blocker]:"));
    expect(disposedEntries).toHaveLength(1);
    expect(disposedEntries[0].action).toContain("deadlock-prevention threshold reached after 3 identical stalls");

    manager.stop();
  });

  /*
  KB-046 scenario E — the narrowness fence at sweep level: a marked-status fixture (task STATUS
  "failed" with a retryable worktree-creation error, the FN-4885 disposition shape) under FORCED
  saturation still surfaces and disposes after threshold identical stalls. Its reason is
  `task is marked 'failed': …`, NOT the failed-pre-merge-step sentence, so the exemption must not
  swallow it — other reasons keep counting end to end.
  */
  it("scenario E (KB-046): a marked-status merge-blocker under forced saturation still surfaces and disposes", async () => {
    const task = failedPreMergeStepTask({
      status: "failed",
      error: WORKTREE_CREATION_ERROR,
      workflowStepResults: [],
    });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      getConcurrencyCapacity: () => ({ claimed: 2, maxConcurrent: 2 }),
    });

    for (const timestamp of ["2026-01-01T00:10:00.000Z", "2026-01-01T00:12:00.000Z"]) {
      vi.setSystemTime(new Date(timestamp));
      expect(await manager.surfaceInReviewStalls()).toBe(1);
    }

    expect(task.paused).toBeFalsy();
    expect(task.log!.filter((entry) => entry.action.startsWith("In-review stall surfaced [merge-blocker]:"))).toHaveLength(2);
    expect(task.log!.some((entry) => entry.action.startsWith("In-review stall suppressed ["))).toBe(false);
    // The surfaced reason is the marked-status sentence, not the failed-pre-merge-step sentence.
    expect(task.log![0].action).toBe(`In-review stall surfaced [merge-blocker]: ${MARKED_STATUS_REASON}`);

    // Tick 3 — threshold reached despite forced saturation: the narrowness fence holds.
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.status).toBe("failed");
    expect(task.log!.filter((entry) => entry.action.startsWith("In-review stall auto-disposed [merge-blocker]:"))).toHaveLength(1);
    expect((store.updateTask as any).mock.calls).toHaveLength(1);

    manager.stop();
  });
});
