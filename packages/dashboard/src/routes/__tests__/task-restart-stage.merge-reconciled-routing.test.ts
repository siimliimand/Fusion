import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { restartTaskStage } from "../task-restart-stage.js";

/*
 * FNXC:MergeConfirmationReconcile 2026-11-04-09:39:
 * Surface-enumeration companion to FIX-2: `retryLandedVerification` routes on
 * `mergeDetails.mergeConfirmed`. After reconciliation clears a phantom confirmation, Retry must
 * route to the stage-restart publication (the merge re-open path) and never answer with the
 * misleading "already approved/pending; landing proof is preserved" conflict that a confirmed
 * landing gets.
 */
vi.mock("@fusion/engine", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resumeMissingPostMergeGate: vi.fn(),
}));

const task = {
  id: "FN-SUBC",
  column: "in-review",
  status: null,
  paused: false,
  userPaused: false,
  mergeDetails: {
    mergeConfirmed: false,
    reconciliation: {
      clearedAt: "2026-11-04T09:00:00.000Z",
      reason: "recorded-sha-not-on-target",
      recordedSha: "a".repeat(40),
    },
  },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-04T09:00:00.000Z",
} as unknown as Task;

function fixtureStore(taskRow: Task): TaskStore {
  const store = {
    getRootDir: () => "/tmp/fusion-restart-stage-fixture",
    getTask: vi.fn(async () => taskRow),
    getSettings: vi.fn(async () => ({}) as Settings | Partial<Settings>),
    getTaskWorkflowSelection: vi.fn(async () => undefined),
    withPlanningLifecycleLock: vi.fn(async (_taskId: string, fn: () => Promise<unknown>) => fn()),
    updateTaskAtomic: vi.fn(async (_id: string, update: (live: Task) => Record<string, unknown> | null) => {
      const patch = update(taskRow);
      if (patch) Object.assign(taskRow, patch);
      return taskRow;
    }),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(taskRow, patch);
      return taskRow;
    }),
    pauseTask: vi.fn(async () => taskRow),
    resetTerminalFailureAutoRecoveryBudget: vi.fn(async () => undefined),
    cancelActiveWorkflowWorkItemsForTask: vi.fn(async () => undefined),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: Record<string, unknown>) => ({ id: "wi-1", ...input })),
    logEntry: vi.fn(async () => undefined),
  };
  return store as unknown as TaskStore;
}

describe("restartTaskStage routing after mergeConfirmed reconciliation", () => {
  it("routes a reconciled (mergeConfirmed=false) card to stage restart, not the landed-verification conflict", async () => {
    const taskRow = structuredClone(task) as Task;
    const store = fixtureStore(taskRow);

    const { resumeMissingPostMergeGate } = await import("@fusion/engine");
    const result = await restartTaskStage({ store, taskId: taskRow.id, confirm: true });

    expect(resumeMissingPostMergeGate).not.toHaveBeenCalled();
    // The publication reached the stage-restart arm: an in-column continuation at the entry node.
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
    const continuation = (store.replaceActiveTaskWorkflowContinuation as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(continuation).toMatchObject({
      taskId: "FN-SUBC",
      kind: "task",
      state: "runnable",
      sourceColumn: "in-review",
      targetColumn: "in-review",
    });
    expect(continuation.nodeId).toBeTruthy();
    expect(result.column).toBe("in-review");
  });
});
