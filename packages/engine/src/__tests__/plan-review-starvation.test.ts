import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

import {
  clearPreHeldExecutorSlotsForTests,
  dropPreHeldExecutorSlot,
  projectAdmissionCoordinator,
  registerPreHeldExecutorSlot,
  takePreHeldExecutorSlot,
} from "../concurrency/concurrency.js";
import { TaskExecutor } from "../executor.js";
import { TriageProcessor } from "../triage.js";
import {
  createPlanningContinuationDispatcher,
  drainDuePlanningContinuations,
  runCapacityWakePass,
} from "../runtimes/in-process-runtime.js";
import {
  MAX_CAPACITY_WAKE_BATCH,
  inspectOldestSuspendedCapacityContinuation,
  selectCapacityWakeCandidates,
  type CapacityWakeSkipReason,
} from "../workflows/capacity-wake.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

/*
FNXC:PlanReviewCapacityWake 2026-11-06-06:07 (KB-009 / FIX-12, SUBC-016):
Regression suite for plan-review capacity starvation.

Original symptom (SUBC-016, subcontractor-marketplace board): one card sat runnable at
the plan-review node ~24h, re-seeded 239-240 times by the ~10-minute self-healing sweep
(staleness ~33h), 13 task:workflow-run-suspended events all reason "capacity", zero
cards entered development all day — while tasks created that same evening were admitted
to plan immediately. Root cause: the due-poll drain selects ONLY
states:["runnable","retrying"], so a held capacity continuation is invisible to every
dispatcher between reclaim sweeps, and each freed slot was claimed by fresher intake
before the aged row's next attempt.

Invariants under test:
- release-triggered resume (no reconcile wait) — the acceptance gate
- boundary age-priority over fresh intake in the same poll
- every fence: paused / userPaused / approval-held / autoMerge:false / engine-paused /
  terminal / deleted / live tasks are never woken
- the wake adds no capacity: an over-cap board refuses the dispatch and the row stays
  runnable for the next tick
*/

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const SETTINGS: Settings = { autoMerge: true } as Settings;

function heldItem(patch: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "wi-1",
    runId: "run-1",
    taskId: "FN-100",
    nodeId: "plan-review",
    kind: "task",
    state: "held",
    attempt: 1,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    stableWorkflowRunId: "FN-100:workflow",
    continuationSequence: 1,
    waitReason: "capacity",
    sourceColumn: "todo",
    targetColumn: "in-progress",
    irHash: null,
    principalAgentId: null,
    workflowRole: null,
    authorityKind: null,
    nodeInstanceId: null,
    createdAt: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-06T10:00:00.000Z",
    ...patch,
  } as WorkflowWorkItem;
}

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    status: null,
    priority: "medium",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    paused: false,
    userPaused: false,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    ...patch,
  } as Task;
}

function selectorInput(patch: {
  items?: WorkflowWorkItem[];
  minAgeMs?: number;
  enginePaused?: boolean;
  settings?: Pick<Settings, "autoMerge">;
  tasks?: Task[];
  resolveTerminalColumns?: (taskId: string) => Promise<ReadonlySet<string>>;
  isTaskLive?: (taskId: string) => boolean;
} = {}) {
  const tasks = patch.tasks ?? [task("FN-100")];
  return {
    items: patch.items ?? [heldItem()],
    now: NOW,
    minAgeMs: patch.minAgeMs,
    enginePaused: patch.enginePaused,
    settings: patch.settings ?? SETTINGS,
    getTask: async (taskId: string) => tasks.find((candidate) => candidate.id === taskId) ?? null,
    resolveTerminalColumns: patch.resolveTerminalColumns,
    isTaskLive: patch.isTaskLive,
  };
}

describe("selectCapacityWakeCandidates — pure selector fences", () => {
  it("orders candidates oldest-first and bounds the batch to 5 of 7", async () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      heldItem({
        id: `wi-${index}`,
        taskId: `FN-${200 + index}`,
        // Later createdAt = younger = should sort later.
        createdAt: new Date(NOW - 60_000 * (index + 1)).toISOString(),
        updatedAt: new Date(NOW - 60_000 * (index + 1)).toISOString(),
      }),
    );
    const tasks = items.map((item) => task(item.taskId));
    const result = await selectCapacityWakeCandidates(selectorInput({ items, tasks }));

    expect(result.candidates).toHaveLength(MAX_CAPACITY_WAKE_BATCH);
    expect(MAX_CAPACITY_WAKE_BATCH).toBe(5);
    const waited = result.candidates.map((candidate) => candidate.waitedMs);
    // Oldest (largest waitedMs) first.
    for (let i = 1; i < waited.length; i++) {
      expect(waited[i - 1]).toBeGreaterThanOrEqual(waited[i]);
    }
    expect(result.candidates[0].item.taskId).toBe("FN-206");
    expect(result.candidates[4].item.taskId).toBe("FN-202");
    // Refusals carry the batch bound so no candidate is silently dropped.
    expect(result.refusals.filter((r) => r.reason === "too-young")).toHaveLength(0);
  });

  it("excludes non-task kinds, wrong wait reasons, and blocked-reason rows", async () => {
    const items = [
      heldItem({ id: "wi-manual", taskId: "FN-300", kind: "manual-hold" as WorkflowWorkItem["kind"] }),
      heldItem({ id: "wi-planning", taskId: "FN-301", waitReason: "planning" }),
      heldItem({ id: "wi-null", taskId: "FN-302", waitReason: null }),
      heldItem({ id: "wi-principal", taskId: "FN-303", blockedReason: "workflow-principal-triage" }),
      heldItem({ id: "wi-filescope", taskId: "FN-304", blockedReason: "file-scope:FN-999" }),
      heldItem({ id: "wi-not-held", taskId: "FN-305", state: "runnable" }),
    ];
    const tasks = items.map((item) => task(item.taskId));
    const result = await selectCapacityWakeCandidates(selectorInput({ items, tasks }));

    expect(result.candidates).toHaveLength(0);
    const reasons = new Map(result.refusals.map((r) => [r.item.id, r.reason]));
    expect(reasons.get("wi-manual")).toBe<CapacityWakeSkipReason>("non-task-kind");
    expect(reasons.get("wi-planning")).toBe<CapacityWakeSkipReason>("wrong-wait-reason");
    expect(reasons.get("wi-null")).toBe<CapacityWakeSkipReason>("wrong-wait-reason");
    expect(reasons.get("wi-principal")).toBe<CapacityWakeSkipReason>("blocked-reason");
    expect(reasons.get("wi-filescope")).toBe<CapacityWakeSkipReason>("blocked-reason");
    expect(reasons.get("wi-not-held")).toBe<CapacityWakeSkipReason>("not-held");
  });

  it("refuses each operator/lifecycle fence with its machine-readable reason", async () => {
    const cases: Array<{ taskId: string; makeTask: () => Task; reason: CapacityWakeSkipReason }> = [
      { taskId: "FN-400", makeTask: () => task("FN-400", { paused: true }), reason: "task-paused" },
      { taskId: "FN-401", makeTask: () => task("FN-401", { userPaused: true }), reason: "task-user-paused" },
      {
        taskId: "FN-402",
        makeTask: () => task("FN-402", { status: "awaiting-approval" }),
        reason: "awaiting-approval",
      },
      { taskId: "FN-403", makeTask: () => task("FN-403", { autoMerge: false }), reason: "auto-merge-off" },
      { taskId: "FN-404", makeTask: () => task("FN-404", { deletedAt: "2026-11-05T01:00:00.000Z" }), reason: "task-deleted" },
      { taskId: "FN-405", makeTask: () => task("FN-405", { column: "done" }), reason: "task-terminal" },
      { taskId: "FN-406", makeTask: () => task("FN-406", { column: "archived" }), reason: "task-terminal" },
    ];
    for (const { taskId, makeTask, reason } of cases) {
      const result = await selectCapacityWakeCandidates(selectorInput({
        items: [heldItem({ taskId })],
        tasks: [makeTask()],
      }));
      expect(result.candidates, `${taskId} should be refused (${reason})`).toHaveLength(0);
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0].reason).toBe(reason);
    }
  });

  it("refuses project-level autoMerge:false even when the task omits its own value", async () => {
    const result = await selectCapacityWakeCandidates(selectorInput({
      settings: { autoMerge: false } as Settings,
    }));
    expect(result.candidates).toHaveLength(0);
    expect(result.refusals[0].reason).toBe("auto-merge-off");
  });

  it("refuses everything while the engine is paused", async () => {
    const result = await selectCapacityWakeCandidates(selectorInput({ enginePaused: true }));
    expect(result.candidates).toHaveLength(0);
    expect(result.refusals.map((r) => r.reason)).toEqual(["engine-paused"]);
  });

  it("refuses a live task (active session/executor lock) and a missing task", async () => {
    const live = await selectCapacityWakeCandidates(selectorInput({ isTaskLive: () => true }));
    expect(live.candidates).toHaveLength(0);
    expect(live.refusals[0].reason).toBe("live-task");

    const missing = await selectCapacityWakeCandidates(selectorInput({ tasks: [] }));
    expect(missing.candidates).toHaveLength(0);
    expect(missing.refusals[0].reason).toBe("task-missing");
  });

  it("honors the resolved terminal columns over the legacy pair", async () => {
    // "completed" is only terminal per the RESOLVED lifecycle set; a board may
    // rename done. The selector must consult that set, not the legacy pair.
    const resolved = await selectCapacityWakeCandidates(selectorInput({
      items: [heldItem({ taskId: "FN-502" })],
      tasks: [task("FN-502", { column: "completed" })],
      resolveTerminalColumns: async () => new Set(["completed"]),
    }));
    expect(resolved.candidates).toHaveLength(0);
    expect(resolved.refusals[0].reason).toBe("task-terminal");

    // And the resolved set REPLACES the legacy pair: a board where "done" is a
    // live column keeps the row wakeable.
    const renamedLive = await selectCapacityWakeCandidates(selectorInput({
      items: [heldItem({ taskId: "FN-503" })],
      tasks: [task("FN-503", { column: "done" })],
      resolveTerminalColumns: async () => new Set(["completed"]),
    }));
    expect(renamedLive.candidates).toHaveLength(1);
  });

  it("honors minAgeMs (0 = no gate) and marks younger rows too-young", async () => {
    // Row is 2h old.
    const input = selectorInput({ items: [heldItem()], minAgeMs: 3 * 60 * 60_000 });
    const young = await selectCapacityWakeCandidates(input);
    expect(young.candidates).toHaveLength(0);
    expect(young.refusals[0].reason).toBe("too-young");

    const aged = await selectCapacityWakeCandidates(selectorInput({ minAgeMs: 30 * 60_000 }));
    expect(aged.candidates).toHaveLength(1);
    expect(aged.candidates[0].waitedMs).toBe(2 * 60 * 60_000);

    const noGate = await selectCapacityWakeCandidates(selectorInput({ minAgeMs: 0 }));
    expect(noGate.candidates).toHaveLength(1);
  });

  it("is a silent no-op for an empty set", async () => {
    const result = await selectCapacityWakeCandidates(selectorInput({ items: [] }));
    expect(result.candidates).toEqual([]);
    expect(result.refusals).toEqual([]);
  });

  it("falls back to updatedAt when createdAt is unparseable and sorts it last", async () => {
    const old = heldItem({
      id: "wi-old",
      taskId: "FN-500",
      createdAt: "not-a-date",
      updatedAt: new Date(NOW - 5 * 60 * 60_000).toISOString(),
    });
    const young = heldItem({
      id: "wi-young",
      taskId: "FN-501",
      createdAt: new Date(NOW - 60_000).toISOString(),
      updatedAt: new Date(NOW - 60_000).toISOString(),
    });
    const result = await selectCapacityWakeCandidates(selectorInput({
      items: [young, old],
      tasks: [task("FN-500"), task("FN-501")],
    }));
    expect(result.candidates.map((c) => c.item.id)).toEqual(["wi-old", "wi-young"]);
    expect(result.candidates[0].waitedMs).toBe(5 * 60 * 60_000);
  });
});

describe("inspectOldestSuspendedCapacityContinuation — throttle-audit inspection", () => {
  it("counts held capacity rows and reports the oldest wait, null when none", () => {
    const items = [
      heldItem({ id: "wi-a", createdAt: new Date(NOW - 60_000).toISOString() }),
      heldItem({ id: "wi-b", taskId: "FN-101", createdAt: new Date(NOW - 90 * 60_000).toISOString() }),
      heldItem({ id: "wi-c", taskId: "FN-102", waitReason: "planning" }),
      heldItem({ id: "wi-d", taskId: "FN-103", state: "runnable", waitReason: null }),
    ];
    const inspection = inspectOldestSuspendedCapacityContinuation(items, NOW);
    expect(inspection.count).toBe(2);
    expect(inspection.oldestWaitMs).toBe(90 * 60_000);

    expect(inspectOldestSuspendedCapacityContinuation([], NOW)).toEqual({ count: 0, oldestWaitMs: null });
    const noneSuspended = inspectOldestSuspendedCapacityContinuation(
      [heldItem({ waitReason: "planning" })],
      NOW,
    );
    expect(noneSuspended).toEqual({ count: 0, oldestWaitMs: null });
  });
});

interface RecordedEvent {
  mutationType: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

/*
FNXC:PlanReviewCapacityWake 2026-11-06-06:07:
Stub store covering the wake + admission + settle surface, mirroring the
workflow-continuation-capacity.test.ts harness shape (real
projectAdmissionCoordinator, stubbed WorkflowIrResolverStore reads).
*/
function buildWakeHarness(input: {
  tasks?: Task[];
  items?: WorkflowWorkItem[];
  settings?: Partial<Settings>;
  onTransition?: (itemId: string, state: WorkflowWorkItem["state"]) => void;
  recordRunAuditEvent?: (event: { mutationType: string; target?: string; metadata?: Record<string, unknown> }) => unknown;
} = {}) {
  const tasks = input.tasks ?? [task("FN-100")];
  /*
   * FNXC:PlanReviewCapacityWake 2026-11-06-06:07:
   * The wake pass reads the REAL clock (deps.now defaults to Date.now), so harness
   * rows must carry a genuinely past createdAt — the selector's minAge gate treats a
   * future timestamp as a negative wait and refuses it (by design). Age everything
   * into the past; tests that need exact ages go through the pure selector instead.
   */
  const items = (input.items ?? [heldItem()]).map((item) => ({
    ...item,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const settings: Settings = {
    maxConcurrent: 4,
    maxWorktrees: 4,
    worktreeLimitEnabled: false,
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    ...input.settings,
  } as Settings;
  const transitions: Array<{ itemId: string; state: WorkflowWorkItem["state"]; patch: Record<string, unknown> }> = [];
  const recorded: RecordedEvent[] = [];
  const store = {
    getSettings: vi.fn(async () => settings),
    // The runtime's continuation drain reads the stable per-project identity.
    getRootDir: vi.fn(() => "/test/kb-009-root"),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (taskId: string) => tasks.find((candidate) => candidate.id === taskId) ?? null),
    listDueWorkflowWorkItems: vi.fn(async () => items),
    transitionWorkflowWorkItem: vi.fn(async (itemId: string, state: WorkflowWorkItem["state"], patch: Record<string, unknown> = {}) => {
      transitions.push({ itemId, state, patch });
      input.onTransition?.(itemId, state);
      const source = items.find((item) => item.id === itemId);
      return { ...(source ?? {}), state };
    }),
    logEntry: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; target?: string; metadata?: Record<string, unknown> }) => {
      input.recordRunAuditEvent?.(event);
      recorded.push({ mutationType: event.mutationType, target: event.target, metadata: event.metadata });
      return undefined;
    }),
  } as unknown as TaskStore;
  return { store, tasks, items, settings, transitions, recorded };
}

/** Drain the promise chain WITHOUT advancing any timer — the release-triggered
 *  resume must complete on microtasks alone (that is the whole point of the fix). */
async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("wake-on-release — release triggers resume without reconcile wait", () => {
  afterEach(() => {
    projectAdmissionCoordinator.clearReservationsForTests();
    clearPreHeldExecutorSlotsForTests();
  });

  it("one release event flips the held row and dispatches it with no timer advance", async () => {
    const execute = vi.fn(async () => {});
    const onSlotReleased = vi.fn();
    const { store, transitions, recorded } = buildWakeHarness();

    const dispatch = createPlanningContinuationDispatcher({
      store,
      projectId: "/test/kb-009-release",
      execute,
      onSlotReleased,
    });
    // ONE release event → the wake pass. No fake timers, no sleeps, no reconcile cadence.
    const flipped = await runCapacityWakePass({
      store,
      drain: () =>
        drainDuePlanningContinuations({
          listDue: async () => [
            // The row as the drain sees it AFTER the flip: runnable, due now.
            heldItem({ state: "runnable" }),
          ],
          getTask: async (taskId) => (await store.getTask(taskId)) ?? undefined,
          cancelOrphan: async () => {},
          defer: async () => {},
          dispatch,
          nowMs: () => Date.now(),
          warn: () => {},
        }),
      warn: () => {},
    });

    expect(flipped).toBe(1);
    // The CAS shape: held → runnable, compare-and-set, fences cleared.
    expect(transitions).toContainEqual(
      expect.objectContaining({ itemId: "wi-1", state: "runnable", patch: expect.objectContaining({ expectedState: "held" }) }),
    );
    // Dispatched through admitPlanningContinuation → the executor entry point.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(task("FN-100"));
    await flushMicrotasks();
    // The settle-side release event fired for this continuation-dispatched run.
    expect(onSlotReleased).toHaveBeenCalledTimes(1);
    // ids/counts-only audit row landed for the resumed row.
    expect(recorded).toContainEqual(
      expect.objectContaining({
        mutationType: "task:capacity-wake-resumed",
        metadata: expect.objectContaining({ taskId: "FN-100", workItemId: "wi-1", nodeId: "plan-review" }),
      }),
    );
  });

  it("is a no-op when nothing is held (no CAS writes, no drain, no audit)", async () => {
    const execute = vi.fn(async () => {});
    const { store, transitions, recorded } = buildWakeHarness({ items: [] });
    const drain = vi.fn(async () => {});
    const flipped = await runCapacityWakePass({ store, drain, warn: () => {} });
    expect(flipped).toBe(0);
    expect(transitions).toHaveLength(0);
    expect(drain).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a CAS loss silently (concurrent writer wins)", async () => {
    const { store, transitions, recorded } = buildWakeHarness({
      onTransition: () => {
        throw new Error("store raced the wake");
      },
    });
    const drain = vi.fn(async () => {});
    const flipped = await runCapacityWakePass({ store, drain, warn: () => {} });
    expect(flipped).toBe(0);
    expect(transitions).toHaveLength(1);
    expect(drain).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });
});

describe("wake-on-release — audit sink hostility (bounded seam)", () => {
  afterEach(() => {
    projectAdmissionCoordinator.clearReservationsForTests();
    clearPreHeldExecutorSlotsForTests();
  });

  it("a throwing audit sink cannot break the wake", async () => {
    const { store, transitions } = buildWakeHarness({
      recordRunAuditEvent: () => {
        throw new Error("sink down");
      },
    });
    const flipped = await runCapacityWakePass({ store, drain: async () => {}, warn: () => {} });
    expect(flipped).toBe(1);
    expect(transitions).toHaveLength(1);
  });

  it("a hanging audit sink cannot delay the wake's return (detached bounded emission)", async () => {
    const { store, transitions } = buildWakeHarness({
      recordRunAuditEvent: () => new Promise<void>(() => undefined),
    });
    const drain = vi.fn(async () => {});
    const started = Date.now();
    const flipped = await runCapacityWakePass({ store, drain, warn: () => {} });
    expect(flipped).toBe(1);
    expect(drain).toHaveBeenCalledTimes(1);
    // No real wait happened: the pass completed on the promise chain, not on the
    // sink's (unbounded) settlement.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("wake-on-release — fences at the pass boundary", () => {
  afterEach(() => {
    projectAdmissionCoordinator.clearReservationsForTests();
    clearPreHeldExecutorSlotsForTests();
  });

  it("paused / userPaused / approval-held / autoMerge:false rows are never woken", async () => {
    const rows: Array<{ item: WorkflowWorkItem; makeTask: () => Task }> = [
      { item: heldItem({ id: "wi-paused", taskId: "FN-700" }), makeTask: () => task("FN-700", { paused: true }) },
      { item: heldItem({ id: "wi-user", taskId: "FN-701" }), makeTask: () => task("FN-701", { userPaused: true }) },
      {
        item: heldItem({ id: "wi-approval", taskId: "FN-702" }),
        makeTask: () => task("FN-702", { status: "awaiting-approval" }),
      },
      { item: heldItem({ id: "wi-amoff", taskId: "FN-703" }), makeTask: () => task("FN-703", { autoMerge: false }) },
    ];
    const { store, transitions, recorded } = buildWakeHarness({
      items: rows.map((row) => row.item),
      tasks: rows.map((row) => row.makeTask()),
    });
    const drain = vi.fn(async () => {});
    const flipped = await runCapacityWakePass({ store, drain, warn: () => {} });

    expect(flipped).toBe(0);
    // Zero CAS writes, zero audit events.
    expect(transitions).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(drain).not.toHaveBeenCalled();
  });

  it("the engine-paused guard refuses everything before any store listing", async () => {
    const { store, transitions, recorded } = buildWakeHarness({ settings: { globalPause: true } });
    const flipped = await runCapacityWakePass({ store, drain: async () => {}, warn: () => {} });
    expect(flipped).toBe(0);
    expect(store.listDueWorkflowWorkItems).not.toHaveBeenCalled();
    expect(transitions).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });
});

describe("wake-on-release — executor slot-release shell", () => {
  afterEach(() => {
    clearPreHeldExecutorSlotsForTests();
    projectAdmissionCoordinator.clearReservationsForTests();
  });

  function makeExecutorStore(): TaskStore {
    return {
      getSettings: vi.fn(async () => ({})),
      // wireTaskExecutorLifecycle subscribes to store events at construction.
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as TaskStore;
  }

  it("fires onExecutionSlotReleased and drops the slot when a pre-held slot was registered", async () => {
    const onExecutionSlotReleased = vi.fn();
    const executor = new TaskExecutor(makeExecutorStore(), "/test/kb-009-shell", { onExecutionSlotReleased });
    vi.spyOn(executor as unknown as { executeCore: (task: Task) => Promise<void> }, "executeCore").mockResolvedValue(undefined);

    registerPreHeldExecutorSlot("FN-800");
    await executor.execute(task("FN-800"));

    expect(onExecutionSlotReleased).toHaveBeenCalledTimes(1);
    // The drop actually happened: a second drop reports nothing was held.
    expect(dropPreHeldExecutorSlot("FN-800")).toBe(false);
  });

  it("does NOT fire the callback when no slot was registered (transfer/absent paths)", async () => {
    const onExecutionSlotReleased = vi.fn();
    const executor = new TaskExecutor(makeExecutorStore(), "/test/kb-009-shell", { onExecutionSlotReleased });
    vi.spyOn(executor as unknown as { executeCore: (task: Task) => Promise<void> }, "executeCore").mockResolvedValue(undefined);

    // A slot that was registered and transferred to the lane is NOT this call's release.
    registerPreHeldExecutorSlot("FN-801");
    takePreHeldExecutorSlot("FN-801");
    await executor.execute(task("FN-801"));
    // And an unregistered task releases nothing at all.
    await executor.execute(task("FN-802"));

    expect(onExecutionSlotReleased).not.toHaveBeenCalled();
  });

  it("contains a throwing release callback — the run still completes", async () => {
    const executor = new TaskExecutor(makeExecutorStore(), "/test/kb-009-shell", {
      onExecutionSlotReleased: () => {
        throw new Error("wake blew up");
      },
    });
    vi.spyOn(executor as unknown as { executeCore: (task: Task) => Promise<void> }, "executeCore").mockResolvedValue(undefined);
    registerPreHeldExecutorSlot("FN-803");
    await expect(executor.execute(task("FN-803"))).resolves.toBeUndefined();
    expect(dropPreHeldExecutorSlot("FN-803")).toBe(false);
  });
});

describe("wake-on-release — dispatcher settle-side release", () => {
  afterEach(() => {
    projectAdmissionCoordinator.clearReservationsForTests();
    clearPreHeldExecutorSlotsForTests();
  });

  it("invokes onSlotReleased after settle and contains its errors", async () => {
    const onSlotReleased = vi.fn(() => {
      throw new Error("wake failed");
    });
    const { store } = buildWakeHarness();
    const execute = vi.fn(async () => {});
    const dispatch = createPlanningContinuationDispatcher({
      store,
      projectId: "/test/kb-009-settle",
      execute,
      onSlotReleased,
    });

    const admitted = await dispatch(task("FN-100"), heldItem({ state: "runnable" }));
    expect(admitted).toBe(true);
    await flushMicrotasks();
    expect(execute).toHaveBeenCalledTimes(1);
    // Thrown, not swallowed: the callback ran (its error is contained by the closure).
    expect(onSlotReleased).toHaveBeenCalledTimes(1);
  });
});

describe("wake-on-release — runtime method guards", () => {
  function makeRuntime(input: { active: boolean; store: TaskStore }): InProcessRuntime {
    const runtime = new InProcessRuntime(
      { projectId: "p", workingDirectory: "/tmp/kb-009-runtime", isolationMode: "in-process" } as never,
      {} as never,
    ) as unknown as { status: string; taskStore: TaskStore; wakeCapacitySuspendedContinuations: (opts?: { minAgeMs?: number }) => Promise<number> };
    runtime.status = input.active ? "active" : "stopped";
    runtime.taskStore = input.store;
    return runtime as unknown as InProcessRuntime;
  }

  it("is a silent no-op when the runtime is not active", async () => {
    const { store } = buildWakeHarness();
    const runtime = makeRuntime({ active: false, store });
    expect(await runtime.wakeCapacitySuspendedContinuations()).toBe(0);
    expect(store.listDueWorkflowWorkItems).not.toHaveBeenCalled();
  });

  it("refuses everything while engine pause is set (no listings, no writes)", async () => {
    const { store, transitions, recorded } = buildWakeHarness({ settings: { enginePaused: true } });
    const runtime = makeRuntime({ active: true, store });
    expect(await runtime.wakeCapacitySuspendedContinuations()).toBe(0);
    expect(store.listDueWorkflowWorkItems).not.toHaveBeenCalled();
    expect(transitions).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("flips a held capacity row through the runtime method with production liveness wiring", async () => {
    const { store, transitions, recorded } = buildWakeHarness();
    const runtime = makeRuntime({ active: true, store });
    expect(await runtime.wakeCapacitySuspendedContinuations()).toBe(1);
    expect(transitions).toHaveLength(1);
    await flushMicrotasks();
    expect(recorded).toHaveLength(1);
  });
});

/*
FNXC:PlanReviewCapacityWake 2026-11-06-06:07:
Boundary age-priority harness: a TriageProcessor driven exactly the way
triage-planning-slot-release-wake.test.ts drives one (stub store, spied discovery),
with `wakeSuspendedCapacityContinuations` wired to the REAL wake pass + drain +
continuation dispatcher — the same composition the runtime installs, minus the
runtime shell.
*/
function buildPollHarness(input: {
  holder?: Task;
  fresh?: Task[];
  extraTasks?: Task[];
  agedRow?: WorkflowWorkItem | null;
  planReviewCapacityWakeAgeMinutes?: number;
  execute?: (task: Task) => Promise<void>;
}) {
  const ROOT = "/test/kb-009-poll";
  const nowMs = () => Date.now();
  const holder = input.holder ?? task("FN-HOLD", { column: "in-progress" });
  const fresh = input.fresh ?? [];
  const continuationTask = task("FN-AGED", { column: "todo" });
  // Rows aged from the LIVE clock so the age gate is deterministic under real timers.
  const agedRow = input.agedRow === undefined
    ? heldItem({
        id: "wi-aged",
        taskId: "FN-AGED",
        createdAt: new Date(nowMs() - 33 * 60 * 60_000).toISOString(),
        updatedAt: new Date(nowMs() - 33 * 60 * 60_000).toISOString(),
      })
    : input.agedRow;
  /*
   * Honest row ledger: one durable row whose STATE moves. The held due window reads
   * state "held"; the drain's due window reads state "runnable"; the CAS transition
   * moves the row between them exactly once.
   */
  const rowState: WorkflowWorkItem["state"] = "held";
  const rowBox: { item: WorkflowWorkItem | null; state: WorkflowWorkItem["state"] } = {
    item: agedRow ?? null,
    state: rowState,
  };
  const heldRows = () => (rowBox.item && rowBox.state === "held" ? [rowBox.item] : []);
  const runnableRows = () => (rowBox.item && rowBox.state === "runnable" ? [rowBox.item] : []);
  const recorded: RecordedEvent[] = [];
  const settings: Settings = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    worktreeLimitEnabled: false,
    pollIntervalMs: 600_000,
    groupOverlappingFiles: false,
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    planReviewCapacityWakeAgeMinutes: input.planReviewCapacityWakeAgeMinutes ?? 30,
  } as Settings;
  const allTasks = [holder, continuationTask, ...fresh, ...(input.extraTasks ?? [])];
  const store = {
    getSettings: vi.fn(async () => settings),
    getRootDir: vi.fn(() => ROOT),
    listTasks: vi.fn(async () => allTasks),
    getTask: vi.fn(async (taskId: string) => allTasks.find((candidate) => candidate.id === taskId) ?? null),
    listDueWorkflowWorkItems: vi.fn(async () => heldRows()),
    transitionWorkflowWorkItem: vi.fn(async (itemId: string, state: WorkflowWorkItem["state"], _patch: Record<string, unknown> = {}) => {
      if (rowBox.item?.id !== itemId) return { id: itemId, state };
      rowBox.state = state;
      return { ...rowBox.item, state };
    }),
    logEntry: vi.fn(async () => undefined),
    updateTask: vi.fn(async () => undefined),
    // TriageProcessor subscribes to store events at construction.
    on: vi.fn(),
    off: vi.fn(),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; target?: string; metadata?: Record<string, unknown> }) => {
      recorded.push({ mutationType: event.mutationType, target: event.target, metadata: event.metadata });
      return undefined;
    }),
  } as unknown as TaskStore;

  const events: string[] = [];
  const execute = vi.fn(async (dispatched: Task) => {
    events.push(`continuation:${dispatched.id}`);
    await input.execute?.(dispatched);
  });
  let receivedAgeThresholdMs: number | undefined;
  const drain = () =>
    drainDuePlanningContinuations({
      listDue: async () => runnableRows(),
      getTask: async (taskId) => (await store.getTask(taskId)) ?? undefined,
      cancelOrphan: async () => {},
      defer: async () => {},
      dispatch: createPlanningContinuationDispatcher({
        store,
        projectId: ROOT,
        execute,
        onSlotReleased: () => {},
      }),
      nowMs,
      warn: () => {},
    });
  const wakeSuspendedCapacityContinuations = vi.fn(async ({ ageThresholdMs }: { ageThresholdMs: number }) => {
    receivedAgeThresholdMs = ageThresholdMs;
    return runCapacityWakePass(
      { store, drain, warn: () => {} },
      // The poll hook's contract: the threshold flows into the pass as its age gate.
      { minAgeMs: ageThresholdMs },
    );
  });

  const processor = new TriageProcessor(store, ROOT, { wakeSuspendedCapacityContinuations });
  (processor as unknown as { running: boolean }).running = true;
  const specifyTask = vi.spyOn(processor, "specifyTask").mockImplementation(async (admitted: Task) => {
    events.push(`intake:${admitted.id}`);
  });
  vi.spyOn(processor as unknown as { discoverReadyPlanningTasks: () => Promise<Task[]> }, "discoverReadyPlanningTasks").mockResolvedValue(fresh);
  vi.spyOn(processor as unknown as { sweepStalePlanningStatuses: () => Promise<void> }, "sweepStalePlanningStatuses").mockResolvedValue(undefined);
  const poll = () => (processor as unknown as { poll: () => Promise<void> }).poll();

  return { processor, poll, store, settings, events, execute, specifyTask, recorded, heldRows: () => heldRows(), runnableRows, agedRow, receivedAgeThresholdMs: () => receivedAgeThresholdMs, fresh, continuationTask };
}

describe("boundary age-priority — intake flood on a freed slot", () => {
  afterEach(() => {
    projectAdmissionCoordinator.clearReservationsForTests();
    clearPreHeldExecutorSlotsForTests();
    vi.restoreAllMocks();
  });

  it("admits the aged continuation ahead of fresh parses; intake enters only after it settles", async () => {
    // cap 2: one canonical holder survived, one slot freed; 3 fresh intake candidates.
    const fresh = [
      task("FN-FRESH-1", { createdAt: "2026-11-06T09:00:00.000Z" }),
      task("FN-FRESH-2", { createdAt: "2026-11-06T09:01:00.000Z" }),
      task("FN-FRESH-3", { createdAt: "2026-11-06T09:02:00.000Z" }),
    ];
    let releaseContinuation!: () => void;
    const continuationRun = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    const harness = buildPollHarness({ fresh, execute: () => continuationRun });

    // The poll's boundary hook runs the REAL wake: the aged row dispatches first.
    await harness.poll();

    expect(harness.receivedAgeThresholdMs()).toBe(30 * 60_000);
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.events[0]).toBe("continuation:FN-AGED");
    // While the continuation holds the freed slot, NO fresh parse is admitted.
    expect(harness.specifyTask).not.toHaveBeenCalled();
    expect(harness.events).toEqual(["continuation:FN-AGED"]);

    // The run settles → the slot truly frees → the NEXT poll admits fresh intake.
    releaseContinuation();
    await flushMicrotasks();
    await harness.poll();
    expect(harness.events).toEqual(["continuation:FN-AGED", "intake:FN-FRESH-1"]);
    harness.processor.stop();
  });

  it("admits fresh intake immediately when no capacity-suspended row exists (no regression)", async () => {
    const fresh = [
      task("FN-FRESH-1", { createdAt: "2026-11-06T09:00:00.000Z" }),
      task("FN-FRESH-2", { createdAt: "2026-11-06T09:01:00.000Z" }),
      task("FN-FRESH-3", { createdAt: "2026-11-06T09:02:00.000Z" }),
    ];
    const harness = buildPollHarness({ fresh, agedRow: null });

    await harness.poll();

    // The wake ran as a silent no-op and the freed slot went to the oldest fresh card.
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.specifyTask).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual(["intake:FN-FRESH-1"]);
    expect(harness.recorded.filter((event) => event.mutationType === "task:capacity-wake-resumed")).toHaveLength(0);
    harness.processor.stop();
  });

  it("honors the age threshold: a 10-minute-old row is not priority-woken by the poll path", async () => {
    const fresh = [task("FN-FRESH-1", { createdAt: "2026-11-06T09:00:00.000Z" })];
    const youngRow = heldItem({
      id: "wi-young",
      taskId: "FN-YOUNG",
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const harness = buildPollHarness({
      fresh,
      agedRow: youngRow,
      extraTasks: [task("FN-YOUNG", { column: "todo" })],
    });
    await harness.poll();

    // Default 30-minute threshold from settings reached the wake unchanged...
    expect(harness.receivedAgeThresholdMs()).toBe(30 * 60_000);
    // ...so the 10-minute-old row was refused as too-young: nothing dispatched.
    expect(harness.execute).not.toHaveBeenCalled();
    // And the freed slot still went to fresh intake (no starvation introduced).
    expect(harness.events).toEqual(["intake:FN-FRESH-1"]);

    // The RELEASE path (no age gate) wakes the same row.
    const flipped = await runCapacityWakePass({
      store: harness.store,
      drain: async () => {},
      warn: () => {},
    });
    expect(flipped).toBe(1);
    expect(harness.heldRows()).toHaveLength(0);
    harness.processor.stop();
  });

  it("resolves the configured threshold into the poll hook (10-minute setting honors an 11-minute row)", async () => {
    const fresh = [task("FN-FRESH-1", { createdAt: "2026-11-06T09:00:00.000Z" })];
    const row = heldItem({
      id: "wi-config",
      taskId: "FN-CONFIG",
      createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    const harness = buildPollHarness({
      fresh,
      agedRow: row,
      extraTasks: [task("FN-CONFIG", { column: "todo" })],
      planReviewCapacityWakeAgeMinutes: 10,
    });

    await harness.poll();

    expect(harness.receivedAgeThresholdMs()).toBe(10 * 60_000);
    expect(harness.events[0]).toBe("continuation:FN-CONFIG");
    harness.processor.stop();
  });
});

/*
FNXC:PlanReviewCapacityWake 2026-11-06-07:09 (KB-009 / FIX-12):
SUBC-016 symptom replay. The board shape is the reported incident: a project at its
shared cap with THREE canonical holders, one card with a held `waitReason:"capacity"`
plan-review continuation aged ~33h, and continuous fresh intake eligible. The store
stub filters `listDueWorkflowWorkItems` by the REQUESTED states (real due-window
semantics), which makes the invisibility control a behavioral check rather than a
restatement of a fixture: the drain's `states:["runnable","retrying"]` window simply
cannot see a held row — that IS the starvation mechanism. Intake ordering against the
aged row is asserted by the boundary age-priority suite above; this replay owns the
release-triggered resume and the no-over-cap-dispatch fence with the REAL claimed
arithmetic (`persistedTopLevelAgentTaskIdsFromStore` + `projectAdmissionCoordinator`).
*/
describe("SUBC-016 replay — starvation mechanism, over-cap fence, release-triggered resume", () => {
  afterEach(() => {
    projectAdmissionCoordinator.clearReservationsForTests();
    clearPreHeldExecutorSlotsForTests();
  });

  function buildReplayHarness() {
    const ROOT = "/test/kb-009-replay";
    const aged33hAgo = new Date(Date.now() - 33 * 60 * 60_000).toISOString();
    const holders = [
      task("FN-H1", { column: "in-progress" }),
      task("FN-H2", { column: "in-progress" }),
      task("FN-H3", { column: "in-progress" }),
    ];
    const agedTask = task("FN-AGED", { column: "todo" });
    const fresh = [
      task("FN-FRESH-1", { createdAt: "2026-11-06T09:00:00.000Z" }),
      task("FN-FRESH-2", { createdAt: "2026-11-06T09:01:00.000Z" }),
      task("FN-FRESH-3", { createdAt: "2026-11-06T09:02:00.000Z" }),
    ];
    const agedRow = heldItem({
      id: "wi-aged",
      taskId: "FN-AGED",
      createdAt: aged33hAgo,
      updatedAt: aged33hAgo,
    });
    const rowBox: { state: WorkflowWorkItem["state"] } = { state: "held" };
    const settings: Settings = {
      maxConcurrent: 3,
      maxWorktrees: 4,
      worktreeLimitEnabled: false,
      autoMerge: true,
      globalPause: false,
      enginePaused: false,
    } as Settings;
    const logEntries: string[] = [];
    const recorded: RecordedEvent[] = [];
    const store = {
      getSettings: vi.fn(async () => settings),
      getRootDir: vi.fn(() => ROOT),
      listTasks: vi.fn(async () => [...holders, agedTask, ...fresh]),
      getTask: vi.fn(async (taskId: string) =>
        [...holders, agedTask, ...fresh].find((candidate) => candidate.id === taskId) ?? null),
      /* Real due-window semantics: honor the REQUESTED states so the invisibility
         control below is a behavioral assertion, not a fixture restatement. */
      listDueWorkflowWorkItems: vi.fn(async (query: { states?: WorkflowWorkItem["state"][]; kinds?: string[]; limit?: number }) => {
        const states = new Set(query.states ?? []);
        const kinds = new Set(query.kinds ?? []);
        const match = agedRow.state === undefined || states.has(rowBox.state)
          && (kinds.size === 0 || kinds.has(agedRow.kind));
        const rows = match ? [{ ...agedRow, state: rowBox.state }] : [];
        return query.limit ? rows.slice(0, query.limit) : rows;
      }),
      transitionWorkflowWorkItem: vi.fn(async (itemId: string, state: WorkflowWorkItem["state"], patch: Record<string, unknown> = {}) => {
        if (itemId !== agedRow.id) return null;
        if (patch.expectedState !== undefined && patch.expectedState !== rowBox.state) return null;
        rowBox.state = state;
        return { ...agedRow, state };
      }),
      logEntry: vi.fn(async (_taskId: string, message: string) => {
        logEntries.push(message);
      }),
      // TaskExecutor subscribes to store events at construction (release-event phase).
      on: vi.fn(),
      off: vi.fn(),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async (event: { mutationType: string; target?: string; metadata?: Record<string, unknown> }) => {
        recorded.push({ mutationType: event.mutationType, target: event.target, metadata: event.metadata });
        return undefined;
      }),
    } as unknown as TaskStore;

    const events: string[] = [];
    const execute = vi.fn(async (dispatched: Task) => {
      events.push(`plan-review:${dispatched.id}`);
    });
    // The runtime composition minus the runtime shell: real drain + real dispatcher
    // + real admitPlanningContinuation over the REAL claimed arithmetic.
    const drain = () =>
      drainDuePlanningContinuations({
        listDue: async () => store.listDueWorkflowWorkItems({ kinds: ["task"], states: ["runnable", "retrying"] }),
        getTask: async (taskId) => (await store.getTask(taskId)) ?? undefined,
        cancelOrphan: async () => {},
        defer: async () => {},
        dispatch: createPlanningContinuationDispatcher({ store, projectId: ROOT, execute }),
        nowMs: () => Date.now(),
        warn: () => {},
      });
    // Release-shaped wake: NO age gate. Terminal/liveness resolvers mirror the
    // runtime wiring; the runtime shell itself is covered by its own suite.
    const wake = () =>
      runCapacityWakePass({
        store,
        drain,
        resolveTerminalColumns: async () => new Set(["done", "archived"]),
        isTaskLive: () => false,
        warn: () => {},
      });
    return {
      store, execute, events, wake, drain, recorded, logEntries,
      holderTask: (id: string) => holders.find((candidate) => candidate.id === id)!,
      completeHolder: (id: string) => {
        const holder = holders.find((candidate) => candidate.id === id);
        if (holder) holder.column = "done";
      },
      rowState: () => rowBox.state,
      rehold: () => {
        rowBox.state = "held";
      },
      wakeAuditCount: () => recorded.filter((event) => event.mutationType === "task:capacity-wake-resumed").length,
    };
  }

  it("held row is invisible to the drain window, over-cap wake refuses, ONE release resumes it", async () => {
    const h = buildReplayHarness();

    // (a) CONTROL — the mechanical starvation reason. The drain's due window
    // (states ["runnable","retrying"]) cannot see the held row at all, so between
    // reclaim sweeps NOTHING dispatches it: this is why SUBC-016 starved ~33h.
    const runnableWindow = await h.store.listDueWorkflowWorkItems({ kinds: ["task"], states: ["runnable", "retrying"] });
    expect(runnableWindow).toHaveLength(0);
    const heldWindow = await h.store.listDueWorkflowWorkItems({ kinds: ["task"], states: ["held"] });
    expect(heldWindow.map((item) => item.id)).toEqual(["wi-aged"]);

    // (c) FENCE — with the cap GENUINELY full (3/3 claimed holders), the release-
    // shaped wake flips the row (trigger timing is not capacity-gated) but the
    // admission attempt through the real coordinator REFUSES: the card is never
    // dispatched over-cap and the row stays runnable for the next due-poll tick.
    expect(await h.wake()).toBe(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.rowState()).toBe("runnable");
    expect(h.wakeAuditCount()).toBe(1);
    // The refusal went through the REAL admission diagnostic (claimed 3/3 holders).
    expect(h.logEntries[0]).toContain("capacity exhausted: used=3/3");

    // (b) ACCEPTANCE — re-arm the exact starved shape (row HELD again, which is the
    // state SUBC-016 sat in), then ONE slot-release event with NO timer advance:
    // a real TaskExecutor.execute finishes a holder, its finally drops the pre-held
    // slot, and the runtime's release wiring wakes the row through the gates.
    h.rehold();
    let wakeHandle: Promise<number> | undefined;
    const executor = new TaskExecutor(h.store, "/test/kb-009-replay-executor", {
      onExecutionSlotReleased: () => {
        // Same composition the runtime installs at its executorOptions (fire-and-
        // forget in production; the handle here is test determinism only).
        wakeHandle = h.wake();
      },
    });
    vi.spyOn(executor as unknown as { executeCore: (task: Task) => Promise<void> }, "executeCore").mockImplementation(
      // The graph completion path moves the finishing card out of the live
      // population BEFORE the finally releases its slot — mirror that ordering.
      async (finished: Task) => h.completeHolder(finished.id),
    );
    registerPreHeldExecutorSlot("FN-H1");
    await executor.execute(h.holderTask("FN-H1"));
    expect(wakeHandle).toBeDefined();
    expect(await wakeHandle).toBe(1);
    await flushMicrotasks();

    // Claimed dropped to 2/3, so the SAME gates admit: held→runnable, dispatched
    // through admitPlanningContinuation, plan review runs to completion.
    expect(h.rowState()).toBe("runnable");
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-AGED" }));
    expect(h.events).toEqual(["plan-review:FN-AGED"]);
    expect(h.wakeAuditCount()).toBe(2);
    // Fresh intake stayed pending — the replay's release path never fabricated a
    // planning admission for intake (that ordering is the age-priority suite's job).
    expect(h.events.filter((event) => event.startsWith("intake:"))).toHaveLength(0);
  });
});
