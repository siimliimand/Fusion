/**
 * FNXC:SchedulerDispatchOscillation 2026-11-04-10:09 (FIX-10):
 * Contract tests for the scheduler's oscillation reset on the archived terminal transition.
 *
 * Original symptom (journal 2026-11-03 17:21:16 CET): after `archiveTask` soft-deleted the
 * row, the emitted `task:moved` payload still carried oscillation state, so the scheduler's
 * reset write hit the store's soft-delete fence and warned
 * "Failed to reset dispatch oscillation state for SUBC-007 on move to archived: Task SUBC-007
 * is soft-deleted ...".
 *
 * The fix makes the archive transition own the reset: the emitted payload carries cleared
 * fields, so the handler has no reset write left to attempt against the soft-deleted row
 * (asserted here as no reset-shaped `updateTask` call — the warning is produced only by that
 * write's failure handler). Live terminal moves keep the existing reset behavior, and the
 * settle-window guard clears for terminal targets regardless of soft-delete.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

import { Scheduler } from "../scheduler.js";
import { flushAsyncHandlers } from "./_flush-async-handlers.js";

const OSCILLATION_RESET_PATCH = {
  dispatchStormCount: null,
  lastDispatchAt: null,
  executeRequeueLoopCount: null,
  executeRequeueLoopSignature: null,
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "SUBC-007",
    title: "Archived oscillation",
    description: "",
    column: "archived",
    status: null,
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    columnMovedAt: "2026-11-03T16:21:15.823Z",
    createdAt: "2026-11-03T15:00:00.000Z",
    updatedAt: "2026-11-03T16:21:15.823Z",
    ...overrides,
  } as Task;
}

function createHarness() {
  const listeners = new Map<string, Array<(payload: never) => unknown>>();
  const updateTask = vi.fn(async () => undefined);
  const store = {
    on: vi.fn((event: string, listener: (payload: never) => unknown) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn(),
    getRootDir: vi.fn(() => "/test/project"),
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => []),
    updateTask,
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  const scheduler = new Scheduler(store, {});
  (scheduler as unknown as { running: boolean }).running = true;

  return {
    scheduler,
    updateTask,
    emitTaskMoved: async (payload: { task: Task; from: string; to: string; source: string }) => {
      for (const listener of listeners.get("task:moved") ?? []) {
        await listener(payload as never);
      }
      await flushAsyncHandlers();
    },
  };
}

describe("scheduler oscillation reset on the archived terminal transition", () => {
  it("performs no reset write for the archived transition (payload fields already cleared by the archive)", async () => {
    const { updateTask, emitTaskMoved } = createHarness();

    // The post-fix archive emit shape: the archive cleared the oscillation fields before
    // emitting, and the row is already soft-deleted (deletedAt set).
    await emitTaskMoved({
      task: task({ deletedAt: "2026-11-03T16:21:15.823Z" }),
      from: "done",
      to: "archived",
      source: "engine",
    });

    expect(updateTask).not.toHaveBeenCalledWith("SUBC-007", OSCILLATION_RESET_PATCH);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("still resets oscillation state on live terminal moves", async () => {
    const { updateTask, emitTaskMoved } = createHarness();

    await emitTaskMoved({
      task: task({
        id: "SUBC-008",
        column: "done",
        deletedAt: undefined,
        dispatchStormCount: 3,
        lastDispatchAt: "2026-11-03T15:59:00.000Z",
        executeRequeueLoopCount: 2,
        executeRequeueLoopSignature: "loop-sig",
      }),
      from: "in-review",
      to: "done",
      source: "engine",
    });

    expect(updateTask).toHaveBeenCalledWith("SUBC-008", OSCILLATION_RESET_PATCH);
  });

  it("clears the settle-window guard for the archived transition even though the row is soft-deleted", async () => {
    const { scheduler, emitTaskMoved } = createHarness();
    const settleWindow = (scheduler as unknown as { recentEngineTodoRequeues: Map<string, string> }).recentEngineTodoRequeues;
    settleWindow.set("SUBC-007", "2026-11-03T16:00:00.000Z");

    await emitTaskMoved({
      task: task({ deletedAt: "2026-11-03T16:21:15.823Z" }),
      from: "done",
      to: "archived",
      source: "engine",
    });

    expect(settleWindow.has("SUBC-007")).toBe(false);
  });
});
