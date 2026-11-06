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

FNXC:RetryOutcomeClassification 2026-11-05-21:41 (KB-007, SUBC-008):
Every landed-verification retry outcome is now observable twice: machine-readably in the thrown
ApiError `details` ({ outcome: "deferred" | "refused", reason, workItem? }) and on the card's task
log ("Retry requested from dashboard (post-merge recheck <outcome>: <reason>)"; the reseeded path
logs its operator attribution instead). Paused and engine-paused landed cards refuse with route-local
reasons naming the actual state — the engine's closed reason union is unchanged.
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
    getSettings: vi.fn(async () => ({})),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

async function expectConflict(result: Promise<unknown>, expected: { status: number; message: string | ExpectFragment; details?: Record<string, unknown> }): Promise<void> {
  await expect(result).rejects.toMatchObject({
    name: "ApiError",
    statusCode: expected.status,
    message: typeof expected.message === "string" ? expected.message : expect.stringContaining(expected.message.fragment),
    ...(expected.details ? { details: expected.details } : {}),
  });
}
type ExpectFragment = { fragment: string };

describe("FIX-4: landed-verification retry refusals name the guard that fired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { reason: "merge-active", fragment: "while a merge is active", outcome: "deferred" },
    { reason: "lease-fresh", fragment: "fresh checkout lease", outcome: "deferred" },
    { reason: "execution-live", fragment: "executing live", outcome: "deferred" },
    { reason: "finalize-blocker", fragment: "independent blocking status", outcome: "refused" },
    { reason: "workflow-selection-changed", fragment: "workflow selection changed", outcome: "refused" },
  ] as const)("maps %s to a 409 naming that guard", async ({ reason, fragment, outcome }) => {
    const task = landedTaskFixture();
    const store = storeFor(task);
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "not-resumable", reason });
    await expectConflict(restartTaskStage({ store, taskId: task.id, confirm: true }), {
      status: 409,
      message: { fragment },
      details: { outcome, reason },
    });
    expect(resumeMissingPostMergeGateMock).toHaveBeenCalledWith(expect.anything(), task.id, { manualRetry: true });
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining(`${outcome}: ${reason}`));
  });

  it("names the orphaned work item (id, kind, state) for active-work-items", async () => {
    const task = landedTaskFixture();
    const store = storeFor(task);
    resumeMissingPostMergeGateMock.mockResolvedValue({
      outcome: "not-resumable",
      reason: "active-work-items",
      workItem: { id: "wi-orphan-9f2", kind: "merge", state: "runnable" },
    });
    await expectConflict(restartTaskStage({ store, taskId: task.id, confirm: true }), {
      status: 409,
      message: "Post-merge verification recheck blocked: active workflow work item wi-orphan-9f2 (merge, state runnable) belongs to a dead run — self-healing will fail it; retry after",
      details: { outcome: "deferred", reason: "active-work-items", workItem: { id: "wi-orphan-9f2", kind: "merge", state: "runnable" } },
    });
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("deferred: active-work-items"));
  });

  it("keeps a truthful active-work-items message even when no item detail is available", async () => {
    const task = landedTaskFixture();
    const store = storeFor(task);
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "not-resumable", reason: "active-work-items" });
    await expectConflict(restartTaskStage({ store, taskId: task.id, confirm: true }), {
      status: 409,
      message: { fragment: "active workflow work item" },
      details: { outcome: "deferred", reason: "active-work-items" },
    });
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("deferred: active-work-items"));
  });

  it("keeps the landing-proof-preserved message only for the genuinely approved/pending (not-due) case", async () => {
    const task = landedTaskFixture();
    const store = storeFor(task);
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "not-resumable", reason: "not-due" });
    await expectConflict(restartTaskStage({ store, taskId: task.id, confirm: true }), {
      status: 409,
      message: "Post-merge verification cannot be retried while pending, active, held, or already approved; landing proof is preserved",
      details: { outcome: "refused", reason: "not-due" },
    });
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("refused: not-due"));
  });

  it("still seeds immediately when the manual retry is eligible (SUBC-008 regression)", async () => {
    const task = landedTaskFixture();
    const store = storeFor(task);
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "resumed", gateId: "post-merge-verification" });

    const result = await restartTaskStage({ store, taskId: task.id, confirm: true });

    expect(result).toBe(task);
    expect(resumeMissingPostMergeGateMock).toHaveBeenCalledWith(store, task.id, { manualRetry: true });
    expect((store.getTask as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0] === task.id).length).toBeGreaterThanOrEqual(2);
    // The reseed is attributed to the operator's Retry on the card's task log.
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("post-merge gate 'post-merge-verification' reseeded for verification recheck"));
  });

  it("refuses a paused landed card with a route-local card-paused reason before invoking the seeder", async () => {
    const task = { ...landedTaskFixture(), paused: true } as Task;
    const store = storeFor(task);
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "resumed", gateId: "post-merge-verification" });

    await expectConflict(restartTaskStage({ store, taskId: task.id, confirm: true }), {
      status: 409,
      message: "Retry is unavailable while the card is paused; resume it, then retry",
      details: { outcome: "refused", reason: "card-paused" },
    });
    expect(resumeMissingPostMergeGateMock).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("refused: card-paused"));
  });

  it.each([{ userPaused: true } as Partial<Task>])("refuses a user-paused landed card identically: %j", async (patch) => {
    const task = { ...landedTaskFixture(), ...patch } as Task;
    const store = storeFor(task);
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "resumed", gateId: "post-merge-verification" });

    await expectConflict(restartTaskStage({ store, taskId: task.id, confirm: true }), {
      status: 409,
      message: "Retry is unavailable while the card is paused; resume it, then retry",
      details: { outcome: "refused", reason: "card-paused" },
    });
    expect(resumeMissingPostMergeGateMock).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("refused: card-paused"));
  });

  it("refuses while the engine is paused with a route-local engine-paused reason before invoking the seeder", async () => {
    const task = landedTaskFixture();
    const store = storeFor(task);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ enginePaused: true });
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "resumed", gateId: "post-merge-verification" });

    await expectConflict(restartTaskStage({ store, taskId: task.id, confirm: true }), {
      status: 409,
      message: "Retry is unavailable while the engine (or all projects) is paused; resume it, then retry",
      details: { outcome: "refused", reason: "engine-paused" },
    });
    expect(resumeMissingPostMergeGateMock).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("refused: engine-paused"));
  });

  it("refuses while all projects are paused identically to an engine pause", async () => {
    const task = landedTaskFixture();
    const store = storeFor(task);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: true });
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "resumed", gateId: "post-merge-verification" });

    await expectConflict(restartTaskStage({ store, taskId: task.id, confirm: true }), {
      status: 409,
      message: { fragment: "engine (or all projects) is paused" },
      details: { outcome: "refused", reason: "engine-paused" },
    });
    expect(resumeMissingPostMergeGateMock).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("refused: engine-paused"));
  });

  it("classifies and audits the early route-level live-merge conflict before the seeder is reached", async () => {
    const task = { ...landedTaskFixture(), status: "merging" } as Task;
    const store = storeFor(task);
    resumeMissingPostMergeGateMock.mockResolvedValue({ outcome: "resumed", gateId: "post-merge-verification" });

    await expectConflict(restartTaskStage({ store, taskId: task.id, confirm: true }), {
      status: 409,
      message: "Retry is unavailable while a merge is active",
      details: { outcome: "deferred", reason: "merge-active" },
    });
    expect(resumeMissingPostMergeGateMock).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("deferred: merge-active"));
  });
});
