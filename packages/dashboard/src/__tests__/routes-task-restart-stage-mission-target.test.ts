// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { restartTaskStage } from "../routes/task-restart-stage.js";

/*
 * FNXC:PostMergeLandingTarget 2026-11-04-09:53 (FIX-11, SUBC-013):
 * Operator Retry on a landed card routes on `mergeDetails.mergeConfirmed` + the post-merge
 * evidence decision — NEVER on branch resolution. A mission task whose landing target is a
 * mission branch (`mergeTargetBranch: "mission/M-..."`) must take the retryLandedVerification
 * path (resume the post-merge gate in place) exactly like a main-landing row; the incident's
 * limbo must not be reachable through Retry either.
 */

const MISSION_SHA = "b7c1e2a4d9b7c1e2a4d9b7c1e2a4d9b7c1e2a4d9";

function missionLandedTask(): Task {
  return {
    id: "SUBC-013",
    title: "Mission delivery",
    description: "d",
    column: "in-review",
    dependencies: [],
    createdAt: "2026-11-04T09:00:00.000Z",
    updatedAt: "2026-11-04T09:00:00.000Z",
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    steps: [{ status: "done" }],
    source: { sourceType: "api" },
    autoMerge: true,
    enabledWorkflowSteps: ["post-merge-verification"],
    workflowStepResults: [],
    mergeDetails: {
      mergeConfirmed: true,
      commitSha: MISSION_SHA,
      mergeTargetBranch: "mission/M-MW0Y99TK-0001-QM7G",
      mergedAt: "2026-11-04T09:05:00.000Z",
    },
  } as unknown as Task;
}

function makeStore(task: Task) {
  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
      const patch = await update(structuredClone(task));
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async () => task),
    logEntry: vi.fn(async () => {}),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getSettingsFast: vi.fn(async () => ({ autoMerge: true })),
    getRootDir: () => "/tmp/does-not-exist",
    listTasks: vi.fn(async () => [task]),
    withPlanningLifecycleLock: vi.fn(async (_taskId: string, work: () => Promise<unknown>) => work()),
    pauseTask: vi.fn(async () => {}),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    recordRunAuditEvent: vi.fn(async () => {}),
    listWorkflowWorkItemsForTask: vi.fn(async () => [] as unknown[]),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded: true, workItemId: "post-merge-continuation" })),
  } as unknown as TaskStore & Record<string, ReturnType<typeof vi.fn>>;
  return store;
}

describe("restartTaskStage retryLandedVerification routes a mission-target landed row to the post-merge gate", () => {
  it("resumes the post-merge gate in place instead of restarting a column", async () => {
    const task = missionLandedTask();
    const store = makeStore(task);

    const result = await restartTaskStage({ store, taskId: task.id, confirm: true });

    expect(result).toBe(task);
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "post-merge-verification", state: "runnable" }),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("[post-merge] Resuming missing verification"),
    );
    // Landed-verification retry never publishes a stage restart: no fence, no column move.
    expect(task.paused).toBeFalsy();
    expect(task.column).toBe("in-review");
    expect(task.mergeDetails?.mergeTargetBranch).toBe("mission/M-MW0Y99TK-0001-QM7G");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });
});
