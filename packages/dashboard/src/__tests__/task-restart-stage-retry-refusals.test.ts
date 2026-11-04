import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import type { PostMergeGateResumeResult } from "@fusion/engine";

const { resumeMissingPostMergeGateMock } = vi.hoisted(() => ({
  resumeMissingPostMergeGateMock: vi.fn<() => Promise<PostMergeGateResumeResult>>(),
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    resumeMissingPostMergeGate: resumeMissingPostMergeGateMock,
  };
});

import { restartTaskStage } from "../routes/task-restart-stage.js";

/*
FNXC:RetryRefusalReasons 2026-11-04-10:25 (FIX-4, SUBC-008):
The landed-verification Retry used to answer ONE hard-coded 409 for every refused reseed; during the
incident the real blocker was an orphaned work item and the message blamed the gate. These tests pin
the reason → message mapping: each refusal names the guard that fired, the legacy approved/pending
message survives only for "not-due", and an eligible manual retry still seeds immediately (the
SUBC-008 live fix).
*/

function landedTaskFixture(): Task {
  return {
    id: "SUBC-8",
    title: "SUBC-8",
    description: "SUBC-8",
    column: "in-review",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeDetails: { mergeConfirmed: true, commitSha: "abc123" },
  } as unknown as Task;
}

function storeFor(task: Task): TaskStore {
  return {
    withPlanningLifecycleLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    getTask: vi.fn(async () => task),
  } as unknown as TaskStore;
}

async function expectConflict(result: Promise<unknown>, expected: { status: number; message: string | ExpectFragment }): Promise<void> {
  await expect(result).rejects.toMatchObject({
    name: "ApiError",
    statusCode: expected.status,
    message: typeof expected.message === "string" ? expected.message : expect.stringContaining(expected.message.fragment),
  });
}
type ExpectFragment = { fragment: string };

describe("FIX-4: landed-verification retry refusals name the guard that fired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { reason: "merge-active", fragment: "while a merge is active" },
    { reason: "lease-fresh", fragment: "fresh checkout lease" },
    { reason: "execution-live", fragment: "executing live" },
    { reason: "finalize-blocker", fragment: "independent blocking status" },
    { reason: "workflow-selection-changed", fragment: "workflow selection changed" },
  ] as const)("maps %s to a 409 naming that guard", async ({ reason, fragment }) => {
    const task = landedTaskFixture();
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "not-resumable", reason });
    await expectConflict(restartTaskStage({ store: storeFor(task), taskId: task.id, confirm: true }), { status: 409, message: { fragment } });
    expect(resumeMissingPostMergeGateMock).toHaveBeenCalledWith(expect.anything(), task.id, { manualRetry: true });
  });

  it("names the orphaned work item (id, kind, state) for active-work-items", async () => {
    const task = landedTaskFixture();
    resumeMissingPostMergeGateMock.mockResolvedValue({
      outcome: "not-resumable",
      reason: "active-work-items",
      workItem: { id: "wi-orphan-9f2", kind: "merge", state: "runnable" },
    });
    await expectConflict(restartTaskStage({ store: storeFor(task), taskId: task.id, confirm: true }), {
      status: 409,
      message: "Post-merge verification recheck blocked: active workflow work item wi-orphan-9f2 (merge, state runnable) belongs to a dead run — self-healing will fail it; retry after",
    });
  });

  it("keeps a truthful active-work-items message even when no item detail is available", async () => {
    const task = landedTaskFixture();
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "not-resumable", reason: "active-work-items" });
    await expectConflict(restartTaskStage({ store: storeFor(task), taskId: task.id, confirm: true }), {
      status: 409,
      message: { fragment: "active workflow work item" },
    });
  });

  it("keeps the landing-proof-preserved message only for the genuinely approved/pending (not-due) case", async () => {
    const task = landedTaskFixture();
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "not-resumable", reason: "not-due" });
    await expectConflict(restartTaskStage({ store: storeFor(task), taskId: task.id, confirm: true }), {
      status: 409,
      message: "Post-merge verification cannot be retried while pending, active, held, or already approved; landing proof is preserved",
    });
  });

  it("still seeds immediately when the manual retry is eligible (SUBC-008 regression)", async () => {
    const task = landedTaskFixture();
    const store = storeFor(task);
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "resumed", gateId: "post-merge-verification" });

    const result = await restartTaskStage({ store, taskId: task.id, confirm: true });

    expect(result).toBe(task);
    expect(resumeMissingPostMergeGateMock).toHaveBeenCalledWith(store, task.id, { manualRetry: true });
    expect((store.getTask as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === task.id).length).toBeGreaterThanOrEqual(2);
  });
});
