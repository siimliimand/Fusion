import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ACTIVE_WORKFLOW_WORK_ITEM_STATES, type Settings, type Task, type TaskStore, type WorkflowWorkItem } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";
import { resumeMissingPostMergeGate } from "../merge/post-merge-gate-reseed.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";

/*
FNXC:OrphanedWorkItemsTest 2026-11-04-09:45 (FIX-3, SUBC-008):
An external-block cleanup tore SUBC-008's run down and a merge-kind work item went `runnable`
700 ms later; no writer ever terminalized it, so it sat active ~22 h and silently vetoed the
designed post-merge-gate reseed. These tests pin the janitor sweep that fails such orphans —
and the liveness veto that leaves genuinely live runs untouched.
*/

/** Past max(30 min, 3× DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS) — the sweep's staleness floor is 3 h. */
const STALE_UPDATED_AT = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
const FRESH_UPDATED_AT = new Date(Date.now() - 5 * 60_000).toISOString();

function workItem(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: `wi-${Math.random().toString(36).slice(2, 8)}`,
    runId: "exec-dead-run",
    taskId: "SUBC-8",
    nodeId: "merge-gate",
    kind: "merge",
    state: "runnable",
    attempt: 1,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    stableWorkflowRunId: null,
    continuationSequence: null,
    waitReason: null,
    sourceColumn: "in-review",
    targetColumn: "in-review",
    irHash: null,
    principalAgentId: null,
    workflowRole: null,
    authorityKind: null,
    nodeInstanceId: null,
    createdAt: STALE_UPDATED_AT,
    updatedAt: STALE_UPDATED_AT,
    ...overrides,
  } as WorkflowWorkItem;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function storeFor(tasks: Task[], items: WorkflowWorkItem[]): TaskStore & EventEmitter {
  const tasksById = new Map(tasks.map((entry) => [entry.id, entry]));
  const itemsById = new Map(items.map((entry) => [entry.id, entry]));
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    getTask: vi.fn(async (id: string) => tasksById.get(id)),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    // Same due-poll semantics the store implements: active states, retryAfter passed/absent,
    // lease expired/absent.
    listDueWorkflowWorkItems: vi.fn(async (filter: { now?: string; states?: string[] } = {}) => {
      const now = filter.now ?? new Date().toISOString();
      const states = filter.states ?? [...ACTIVE_WORKFLOW_WORK_ITEM_STATES];
      return [...itemsById.values()].filter((item) => states.includes(item.state)
        && (item.retryAfter === null || item.retryAfter <= now)
        && (item.leaseExpiresAt === null || item.leaseExpiresAt <= now));
    }),
    transitionWorkflowWorkItem: vi.fn(async (
      id: string,
      state: WorkflowWorkItem["state"],
      patch: { expectedState?: WorkflowWorkItem["state"]; lastError?: string | null; leaseOwner?: string | null; leaseExpiresAt?: string | null; blockedReason?: string | null } = {},
    ) => {
      const item = itemsById.get(id);
      if (!item) throw new Error(`Workflow work item ${id} not found`);
      // CAS no-op: another writer moved the row after the caller's snapshot.
      if (patch.expectedState !== undefined && item.state !== patch.expectedState) return item;
      if (patch.lastError !== undefined) item.lastError = patch.lastError;
      if (patch.leaseOwner !== undefined) item.leaseOwner = patch.leaseOwner;
      if (patch.leaseExpiresAt !== undefined) item.leaseExpiresAt = patch.leaseExpiresAt;
      if (patch.blockedReason !== undefined) item.blockedReason = patch.blockedReason;
      item.state = state;
      item.updatedAt = new Date().toISOString();
      return item;
    }),
  }) as unknown as TaskStore & EventEmitter;
}

function auditCalls(store: TaskStore & EventEmitter): ReturnType<typeof vi.fn> {
  return store.recordRunAuditEvent as ReturnType<typeof vi.fn>;
}

describe("FIX-3: reconcile orphaned active workflow work items", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    executingTaskLock._clearForTest();
    for (const path of ["/wt/orphan-registry-live"]) activeSessionRegistry.unregisterPath(path);
  });

  it("fails a dead-run runnable merge item and audits ids/enums only (SUBC-008 shape)", async () => {
    const orphan = workItem({ kind: "merge", state: "runnable" });
    const owner = task("SUBC-8");
    const store = storeFor([owner], [orphan]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", isMergePending: async () => false });

    expect(await manager.reconcileOrphanedWorkItems()).toBe(1);
    expect(orphan.state).toBe("failed");
    expect(orphan.lastError).toBe("orphaned-by-dead-run");
    expect(orphan.leaseOwner).toBeNull();
    expect(orphan.blockedReason).toBeNull();
    expect(auditCalls(store)).toHaveBeenCalledTimes(1);
    expect(auditCalls(store)).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reconcile-orphaned-work-item",
      target: orphan.id,
      metadata: { taskId: "SUBC-8", workItemId: orphan.id, kind: "merge", priorState: "runnable", outcome: "failed" },
    }));
  });

  it("fails an expired-lease held item but not a lease-fresh one", async () => {
    const expiredHold = workItem({ id: "wi-held-expired", kind: "task", state: "held", leaseOwner: "dead-run", leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(), blockedReason: "workflow-role-pool-unavailable:reviewer" });
    const owner = task("SUBC-8");
    const store = storeFor([owner], [expiredHold]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedWorkItems()).toBe(1);
    expect(expiredHold.state).toBe("failed");

    const liveLease = workItem({ id: "wi-held-live", kind: "task", state: "held", leaseOwner: "live-run", leaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    const store2 = storeFor([owner], [liveLease]);
    expect(await new SelfHealingManager(store2, { rootDir: "/repo" }).reconcileOrphanedWorkItems()).toBe(0);
    expect(liveLease.state).toBe("held");
    expect(auditCalls(store2)).not.toHaveBeenCalled();
  });

  it("vetoes on the liveness triple and emits the no-action audit deduped across sweeps", async () => {
    const registryTask = task("SUBC-A");
    const registryLive = workItem({ id: "wi-live-session", kind: "task", state: "running", taskId: "SUBC-A" });
    const activeTask = task("SUBC-B");
    const executionLive = workItem({ id: "wi-live-exec", kind: "task", state: "runnable", taskId: "SUBC-B" });
    activeSessionRegistry.registerPath("/wt/orphan-registry-live", { taskId: "SUBC-A", kind: "workflow-step", ownerKey: "test" });
    const store = storeFor([registryTask, activeTask], [registryLive, executionLive]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/repo",
      isTaskActive: (id: string) => id === "SUBC-B",
    });

    expect(await manager.reconcileOrphanedWorkItems()).toBe(0);
    expect(await manager.reconcileOrphanedWorkItems()).toBe(0);
    expect(registryLive.state).toBe("running");
    expect(executionLive.state).toBe("runnable");
    // Two candidates, each deduped to exactly one no-action row across both sweeps.
    expect(auditCalls(store)).toHaveBeenCalledTimes(2);
    const auditedIds = auditCalls(store).mock.calls.map((call) => (call[0] as { metadata: { workItemId: string } }).metadata.workItemId);
    expect(new Set(auditedIds)).toEqual(new Set([registryLive.id, executionLive.id]));
    for (const call of auditCalls(store).mock.calls) {
      expect(call[0]).toMatchObject({
        mutationType: "task:reconcile-orphaned-work-item-no-action",
        metadata: expect.objectContaining({ kind: expect.any(String), priorState: expect.any(String), reason: "live-session" }),
      });
    }
  });

  it("bounds one sweep to the starvation budget even with more orphans than it allows", async () => {
    const orphans = Array.from({ length: 5 }, (_, i) => workItem({ id: `wi-budget-${i}`, kind: "task", state: "runnable" }));
    const owner = task("SUBC-8");
    const store = storeFor([owner], orphans);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedWorkItems()).toBe(3);
    expect(orphans.filter((item) => item.state === "failed")).toHaveLength(3);
    expect(orphans.filter((item) => item.state === "runnable")).toHaveLength(2);
    // The next sweep owns the remainder — bounded, never mass-terminalizing in one tick.
    expect(await manager.reconcileOrphanedWorkItems()).toBe(2);
    expect(orphans.every((item) => item.state === "failed")).toBe(true);
  });

  it("skips fresh, operator-owned, paused, workspace, deleted-task, and merge-pending candidates without auditing them", async () => {
    const owner = task("SUBC-8");
    const fresh = workItem({ id: "wi-fresh", kind: "task", state: "runnable", updatedAt: FRESH_UPDATED_AT, createdAt: FRESH_UPDATED_AT });
    const manualHold = workItem({ id: "wi-manual-hold", kind: "manual-hold", state: "held" });
    const deletedTaskItem = workItem({ id: "wi-deleted-task", kind: "task", state: "runnable", taskId: "SUBC-GONE" });
    const mergePending = workItem({ id: "wi-merge-pending", kind: "merge", state: "runnable" });
    const deleted = task("SUBC-GONE", { deletedAt: new Date().toISOString() });
    const workspace = task("SUBC-WS", { workspaceWorktrees: { repo: { path: "/wt/repo", branch: "fusion/SUBC-WS", baseBranch: "main", status: "complete" } } } as Partial<Task>);
    const workspaceItem = workItem({ id: "wi-workspace", kind: "task", state: "runnable", taskId: "SUBC-WS" });
    const store = storeFor([owner, deleted, workspace], [fresh, manualHold, deletedTaskItem, mergePending, workspaceItem]);
    const isMergePending = vi.fn(async () => true);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", isMergePending });

    expect(await manager.reconcileOrphanedWorkItems()).toBe(0);
    expect(fresh.state).toBe("runnable");
    expect(manualHold.state).toBe("held");
    expect(deletedTaskItem.state).toBe("runnable");
    expect(mergePending.state).toBe("runnable");
    expect(workspaceItem.state).toBe("runnable");
    expect(isMergePending).toHaveBeenCalledWith("SUBC-8");
    expect(auditCalls(store)).not.toHaveBeenCalled();

    // The same merge-kind item IS failed once the merge-pending oracle proves nothing is pending.
    const store2 = storeFor([owner], [workItem({ id: mergePending.id, kind: "merge", state: "runnable" })]);
    const manager2 = new SelfHealingManager(store2, { rootDir: "/repo", isMergePending: async () => false });
    expect(await manager2.reconcileOrphanedWorkItems()).toBe(1);
    expect(auditCalls(store2)).toHaveBeenCalledTimes(1);
  });

  it("honors engine pause and leaves live-merge and paused-task items untouched", async () => {
    const owner = task("SUBC-8");
    const item = workItem({ id: "wi-merge-active", kind: "merge", state: "runnable" });
    const store = storeFor([owner], [item]);
    store.getSettings = vi.fn(async () => ({ globalPause: true, enginePaused: false } as Settings)) as never;
    const manager = new SelfHealingManager(store, { rootDir: "/repo", isMergePending: async () => false, getActiveMergeTaskId: () => null });
    expect(await manager.reconcileOrphanedWorkItems()).toBe(0);
    expect(item.state).toBe("runnable");

    // A non-stale merge-active status owns its items even with no activeMergeTaskId.
    const merging = task("SUBC-9", { status: "merging", updatedAt: new Date().toISOString() });
    const mergingItem = workItem({ id: "wi-merging", kind: "merge", state: "runnable", taskId: "SUBC-9" });
    const store2 = storeFor([merging], [mergingItem]);
    expect(await new SelfHealingManager(store2, { rootDir: "/repo", isMergePending: async () => false }).reconcileOrphanedWorkItems()).toBe(0);
    expect(mergingItem.state).toBe("runnable");

    const paused = task("SUBC-10", { userPaused: true });
    const pausedItem = workItem({ id: "wi-paused", kind: "task", state: "runnable", taskId: "SUBC-10" });
    const store3 = storeFor([paused], [pausedItem]);
    expect(await new SelfHealingManager(store3, { rootDir: "/repo" }).reconcileOrphanedWorkItems()).toBe(0);
    expect(pausedItem.state).toBe("runnable");
  });

  it("leaves a row another writer claimed between scan and write untouched (CAS fence)", async () => {
    const orphan = workItem({ id: "wi-raced", kind: "task", state: "runnable" });
    const owner = task("SUBC-8");
    const store = storeFor([owner], [orphan]);
    const transition = store.transitionWorkflowWorkItem as ReturnType<typeof vi.fn>;
    const original = transition.getMockImplementation()!;
    // Simulate a dispatcher claiming the row right before the sweep's write.
    transition.mockImplementation(async (id, state, patch) => {
      if (id === orphan.id) {
        orphan.state = "running";
        orphan.leaseOwner = "fresh-dispatcher";
        return orphan;
      }
      return original(id, state, patch);
    });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    expect(await manager.reconcileOrphanedWorkItems()).toBe(0);
    expect(orphan.state).toBe("running");
    expect(orphan.leaseOwner).toBe("fresh-dispatcher");
    expect(auditCalls(store)).not.toHaveBeenCalled();
  });

  /*
  FNXC:OrphanedWorkItems 2026-11-05-20:39 (KB-006, SUBC-008 symptom acceptance):
  This test is the symptom-based acceptance for FIX-3's operator contract: before the janitor runs,
  the dead run's active merge item makes `resumeMissingPostMergeGate` refuse with the
  "active-work-items" veto on every invocation — the indefinite SUBC-008 wedge that previously
  needed operator SQL repair. After the sweep fails the dead run's item, the SAME reseed path
  reseeds the missing post-merge gate with no operator intervention. All assertions are behavioral:
  the refusal shape before, the item state after the sweep, and the resumed outcome after.
  */
  it("lifts the post-merge-gate reseed veto once the dead run's item is failed (SUBC-008 symptom)", async () => {
    const orphan = workItem({ id: "wi-subc-8-orphan", kind: "merge", state: "runnable" });
    const owner = task("SUBC-8", {
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
    } as Partial<Task>);
    const store = storeFor([owner], [orphan]);
    /*
    Reseed-facing store surface, modeled on confirmed-merge-must-finalize.test.ts's
    recoveryFixture. The seeder mirrors the real store seed's bail gate: refuse with
    "active-continuation" exactly while an ACTIVE-state item exists (the same
    ACTIVE_WORKFLOW_WORK_ITEM_STATES gate the real seed reads) — so a failed item lets the
    seed proceed.
    */
    store.listWorkflowWorkItemsForTask = vi.fn(async () => [orphan]) as never;
    store.seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async () => {
      if (ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(orphan.state)) return { seeded: false, reason: "active-continuation" as const };
      return { seeded: true, workItemId: "post-merge-continuation" };
    }) as never;
    const selection = { workflowId: "builtin:coding", stepIds: ["post-merge-verification"] };
    store.getTaskWorkflowSelection = vi.fn(() => selection) as never;
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => selection) as never;
    const manager = new SelfHealingManager(store, { rootDir: "/repo", isMergePending: async () => false });

    // BEFORE: the dead run's active item vetoes the reseed — the indefinite SUBC-008 wedge.
    await expect(resumeMissingPostMergeGate(store, "SUBC-8")).resolves.toEqual({
      outcome: "not-resumable",
      reason: "active-work-items",
      workItem: { id: orphan.id, kind: "merge", state: "runnable" },
    });

    // The janitor proves the run dead and fails the item (row preserved as forensic evidence).
    expect(await manager.reconcileOrphanedWorkItems()).toBe(1);
    expect(orphan.state).toBe("failed");
    expect(orphan.lastError).toBe("orphaned-by-dead-run");
    expect(orphan.leaseOwner).toBeNull();
    expect(orphan.blockedReason).toBeNull();

    // AFTER: the same reseed path no longer carries the active-item veto — the gate reseeds.
    await expect(resumeMissingPostMergeGate(store, "SUBC-8")).resolves.toEqual({
      outcome: "resumed",
      gateId: "post-merge-verification",
    });
  });
});
