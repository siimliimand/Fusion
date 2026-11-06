import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

import { classifyPostMergeGateRetryOutcome, resumeMissingPostMergeGate } from "../merge/post-merge-gate-reseed.js";

/*
 * FNXC:RetryOutcomeClassification 2026-11-05-21:38 (KB-007, SUBC-008):
 * Manual operator Retry on a merge-confirmed card with a failed post-merge gate is not a machine
 * loop, so it bypasses the automatic recovery backoff and reseeds the gate immediately; the
 * identical fixture WITHOUT manualRetry must still refuse as "not-due" so the pair proves the
 * operator bypass — not luck — reseeded the gate. This file pins the full engine-side manual-retry
 * contract; the dashboard route layer (details payload, task-log audit, pause refusals) is pinned
 * separately in packages/dashboard/src/__tests__/task-restart-stage-retry-refusals.test.ts.
 */
function makeStore(task: Task): TaskStore {
  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task> | Promise<Partial<Task>>) => Object.assign(task, await update(task))),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    logEntry: vi.fn(), recordRunAuditEvent: vi.fn(), getSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
  } as unknown as TaskStore;
  store.moveTaskIf = vi.fn(async (_id, column, predicate, options) => {
    if (!await predicate(task)) return { task, moved: false };
    return { task: await store.moveTask(task.id, column, options), moved: true };
  });
  return store;
}

function freshFailure(): Task["workflowStepResults"] {
  // completedAt is "now", so the automatic 15-minute backoff is NOT due — only the manualRetry
  // bypass can reseed this shape; priorAttempts variants cover the first and backoff-aged curves.
  const rejection = { workflowStepId: "post-merge-verification", phase: "post-merge", status: "failed", verdict: "REVISE", completedAt: new Date().toISOString() };
  return [rejection] as Task["workflowStepResults"];
}

function recoveryFixture() {
  const task = {
    id: "KB-007", column: "in-review", updatedAt: "2026-11-05T00:00:00.000Z",
    autoMerge: true, steps: [], mergeDetails: { mergeConfirmed: true },
    enabledWorkflowSteps: ["post-merge-verification"], workflowStepResults: [],
  } as unknown as Task;
  const store = makeStore(task);
  const items: unknown[] = [];
  store.listWorkflowWorkItemsForTask = vi.fn(async () => items) as never;
  store.seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async (input) => {
    if (items.length) return { seeded: false, reason: "active-continuation" as const };
    items.push(input);
    return { seeded: true, workItemId: "post-merge-continuation" };
  });
  return { task, store, items };
}

describe("KB-007 manual retry of a failed post-merge gate", () => {
  it.each([0, 3])("reseeds a freshly failed gate immediately on manual retry (%i prior attempts)", async (priorAttempts) => {
    const { task, store, items } = recoveryFixture();
    task.workflowStepResults = freshFailure();
    (task.workflowStepResults![0] as { priorAttempts?: unknown[] }).priorAttempts = Array(priorAttempts).fill(task.workflowStepResults![0]);
    const before = structuredClone(task.workflowStepResults);

    const result = await resumeMissingPostMergeGate(store, task.id, { manualRetry: true });

    expect(result).toEqual({ outcome: "resumed", gateId: "post-merge-verification" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ nodeId: "post-merge-verification", kind: "task", state: "runnable", sourceColumn: "in-review", targetColumn: "in-review" });
    // Scheduling a recheck never touches the authoritative gate evidence or its history.
    expect(task.workflowStepResults).toEqual(before);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("leaves the identical fresh-failure fixture untouched WITHOUT manualRetry, proving the operator bypass did the reseed", async () => {
    const { task, store, items } = recoveryFixture();
    task.workflowStepResults = freshFailure();

    await expect(resumeMissingPostMergeGate(store, task.id))
      .resolves.toEqual({ outcome: "not-resumable", reason: "not-due" });
    expect(items).toHaveLength(0);
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  /*
  FNXC:RetryOutcomeClassification 2026-11-05-21:38 (KB-007, SUBC-008):
  The task description's scenario 2 ("autoMerge:false card → truthful refusal naming the
  human-review contract") was SUPERSEDED by the landed FNXC:PostMergeCloseout contract in the
  reseed file and FN-9304 in self-healing.ts: auto-merge authorization governs whether Fusion may
  LAND work; it must not suppress the graph-owned verification of a landing already proven durable.
  A durable landing is closeout work, so the reseed path deliberately carries no autoMerge guard.
  This test pins the CURRENT truthful behavior instead of the superseded refusal premise.
  */
  it("still verifies an autoMerge:false landed card with a fresh failed gate (supersedes the description's scenario-2 refusal premise)", async () => {
    const { task, store, items } = recoveryFixture();
    task.autoMerge = false;
    store.getSettings = vi.fn(async () => ({ autoMerge: false })) as never;
    task.workflowStepResults = freshFailure();

    await expect(resumeMissingPostMergeGate(store, task.id, { manualRetry: true }))
      .resolves.toEqual({ outcome: "resumed", gateId: "post-merge-verification" });
    expect(items).toHaveLength(1);
  });

  it("refuses a non-merge-confirmed card at the seeder without seeding (the route's restart path owns that shape)", async () => {
    const { task, store, items } = recoveryFixture();
    delete (task as { mergeDetails?: unknown }).mergeDetails;

    await expect(resumeMissingPostMergeGate(store, task.id, { manualRetry: true }))
      .resolves.toEqual({ outcome: "not-resumable", reason: "not-due" });
    expect(items).toHaveLength(0);
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("partitions every closed block reason into deferred vs refused", () => {
    // deferred: automatic progress (merge finishing, lease expiry, run completing, sweep failing
    // an orphan) can make a later retry act.
    for (const reason of ["merge-active", "lease-fresh", "execution-live", "active-work-items"] as const) {
      expect(classifyPostMergeGateRetryOutcome(reason)).toBe("deferred");
    }
    // refused: no retry will act until something outside retry changes (blocker resolved,
    // selection reclassified, or the gate itself reports).
    for (const reason of ["finalize-blocker", "workflow-selection-changed", "not-due"] as const) {
      expect(classifyPostMergeGateRetryOutcome(reason)).toBe("refused");
    }
  });
});
