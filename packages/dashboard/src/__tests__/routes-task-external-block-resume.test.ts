// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { republishExternalBlockResumeAsStageRestart, resumeExternallyBlockedTask } from "../routes/task-external-block-resume.js";
import { request as performRequest } from "../test-request.js";

const IR = {
  version: "v2",
  name: "external-block-resume",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "review", name: "Review", traits: [{ trait: "human-review" }] },
  ],
  nodes: [
    { id: "start", kind: "start" },
    { id: "implement", kind: "execute", column: "building" },
    { id: "code-review", kind: "prompt", column: "review" },
  ],
  edges: [
    { from: "start", to: "implement" },
    { from: "implement", to: "code-review" },
  ],
} as never;

function blockedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-209",
    title: "External obstacle",
    description: "Resume exact verification step",
    column: "building",
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "done" },
      { name: "Testing & Verification", status: "in-progress" },
    ],
    currentStep: 2,
    workflowStepResults: [{ workflowStepId: "plan-review", status: "passed" }],
    worktree: "/worktrees/fn-209",
    branch: "fusion/fn-209",
    baseCommitSha: "base-sha",
    status: "blocked",
    error: "BLOCKED: host-environment/ENOSPC: no space left on device, write",
    paused: true,
    pausedReason: "external-block",
    externalBlock: {
      origin: "host-environment",
      code: "ENOSPC",
      message: "no space left on device, write",
      source: "agent-declaration",
      blockedAt: "2026-08-28T00:00:00.000Z",
      resume: {
        column: "building",
        nodeId: "implement",
        currentStep: 2,
        worktree: "/worktrees/fn-209",
        branch: "fusion/fn-209",
      },
    },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(row: Task) {
  const items: Array<Record<string, unknown>> = [];
  const store = {
    getRootDir: vi.fn(() => "/project"),
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn(async () => structuredClone(row)),
    listTasks: vi.fn(async () => [structuredClone(row)]),
    withPlanningLifecycleLock: vi.fn(async (_taskId: string, work: () => Promise<unknown>) => await work()),
    getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "wf-external-block" }),
    getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "wf-external-block", name: "External block", ir: IR }),
    listWorkflowWorkItemsForTask: vi.fn(async () => structuredClone(items)),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: Record<string, unknown>) => {
      for (const item of items) {
        if (item.kind === "task" && ["runnable", "running", "held", "retrying"].includes(String(item.state))) {
          item.state = "cancelled";
        }
      }
      items.push({ id: `continuation-${items.length}`, ...input });
      return input;
    }),
    updateTask: vi.fn(async (_taskId: string, patch: Partial<Task>) => {
      Object.assign(row, patch);
      return structuredClone(row);
    }),
    updateTaskAtomic: vi.fn(async (_taskId: string, mutate: (current: Task) => Partial<Task> | null) => {
      const patch = mutate(structuredClone(row));
      if (patch) Object.assign(row, patch);
      return structuredClone(row);
    }),
    pauseTask: vi.fn(async (_taskId: string, paused: boolean, _reason?: unknown, options?: { pausedReason?: string }) => {
      row.paused = paused;
      row.pausedReason = paused ? (options?.pausedReason ?? null) : null;
      return structuredClone(row);
    }),
    cancelActiveWorkflowWorkItemsForTask: vi.fn(async () => {
      for (const item of items) {
        if (item.kind === "task" && ["runnable", "running", "held", "retrying"].includes(String(item.state))) {
          item.state = "cancelled";
        }
      }
    }),
    resetTerminalFailureAutoRecoveryBudget: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  };
  return { store: store as unknown as TaskStore, items };
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

async function createPrompt(root: string) {
  const taskDir = join(root, ".fusion", "tasks", "FN-209");
  await mkdir(taskDir, { recursive: true });
  const promptPath = join(taskDir, "PROMPT.md");
  await writeFile(promptPath, "# Existing approved plan\n");
  return promptPath;
}

afterEach(() => vi.restoreAllMocks());

describe("external-block Retry", () => {
  it("resumes the recorded node without changing completed work or implementation artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-external-block-resume-"));
    const promptPath = await createPrompt(root);
    const row = blockedTask();
    const before = structuredClone(row);
    const { store, items } = createStore(row);
    vi.mocked(store.getRootDir).mockReturnValue(root);

    const response = await performRequest(createApp(store), "POST", "/api/tasks/FN-209/retry");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row).toMatchObject({
      column: before.column,
      steps: before.steps,
      currentStep: before.currentStep,
      worktree: before.worktree,
      branch: before.branch,
      baseCommitSha: before.baseCommitSha,
      workflowStepResults: before.workflowStepResults,
      paused: false,
      externalBlock: null,
    });
    expect(row.status).toBeNull();
    expect(row.error).toBeNull();
    await expect(readFile(promptPath, "utf8")).resolves.toBe("# Existing approved plan\n");
    expect(items).toEqual([
      expect.objectContaining({
        nodeId: "implement",
        state: "runnable",
        sourceColumn: "building",
        targetColumn: "building",
      }),
    ]);
    expect(store.updateTask).toHaveBeenCalledOnce();
    expect(store.updateTask).toHaveBeenCalledWith("FN-209", expect.not.objectContaining({
      steps: expect.anything(),
      currentStep: expect.anything(),
      worktree: expect.anything(),
      branch: expect.anything(),
      workflowStepResults: expect.anything(),
    }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-209", expect.stringContaining("resuming workflow at implement"));
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:external-block-cleared",
      metadata: expect.objectContaining({ code: "ENOSPC", resumeNodeId: "implement" }),
    }));
    expect(JSON.stringify(vi.mocked(store.recordRunAuditEvent).mock.calls)).not.toContain("no space left on device");
  });

  it("falls back to the recorded column entry when the blocked node id is absent", async () => {
    const row = blockedTask({
      externalBlock: {
        ...blockedTask().externalBlock!,
        resume: { column: "building", currentStep: 2, worktree: "/worktrees/fn-209", branch: "fusion/fn-209" },
      },
    });
    const { store, items } = createStore(row);

    const result = await resumeExternallyBlockedTask({ store: store as never, taskId: row.id });

    expect(result).toMatchObject({ kind: "resumed", nodeId: "implement" });
    expect(items[0]).toMatchObject({ nodeId: "implement" });
  });

  it("refuses a duplicate Retry while the external-block continuation is still pending", async () => {
    const row = blockedTask();
    const { store, items } = createStore(row);
    const app = createApp(store);

    expect((await performRequest(app, "POST", "/api/tasks/FN-209/retry")).status).toBe(200);
    const duplicate = await performRequest(app, "POST", "/api/tasks/FN-209/retry");

    expect(duplicate.status).toBe(409);
    expect(JSON.stringify(duplicate.body)).toContain("already resumed");
    expect(items).toHaveLength(1);
    expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledOnce();
  });

  it("signals non-blocked tasks without mutating them so the existing retry router remains authoritative", async () => {
    const row = blockedTask({ status: "failed", externalBlock: undefined, paused: undefined, pausedReason: undefined });
    const before = structuredClone(row);
    const { store } = createStore(row);

    const result = await resumeExternallyBlockedTask({ store: store as never, taskId: row.id });

    expect(result).toEqual({ kind: "not-blocked" });
    expect(row).toEqual(before);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
  });

  /*
  FNXC:ExternalBlockResumeRetarget 2026-11-04-09:34 (SUBC-008 regression):
  A freeze recorded at a WIP-column node while the card has since advanced to review must not
  republish that node — the graph's containment refuses the backward review → WIP move and the
  run dies with a dead continuation. Publication targets the review entry node through the
  sanctioned stage-restart path instead.
  */
  it("retargets a stale resume node to the current column's stage restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-external-block-resume-"));
    const promptPath = await createPrompt(root);
    const row = blockedTask({ column: "review" });
    const { store, items } = createStore(row);
    vi.mocked(store.getRootDir).mockReturnValue(root);

    const response = await performRequest(createApp(store), "POST", "/api/tasks/FN-209/retry");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(row).toMatchObject({
      column: "review",
      status: null,
      error: null,
      paused: false,
      pausedReason: null,
      externalBlock: null,
      worktree: "/worktrees/fn-209",
      branch: "fusion/fn-209",
      workflowStepResults: [{ workflowStepId: "plan-review", status: "passed" }],
    });
    await expect(readFile(promptPath, "utf8")).resolves.toBe("# Existing approved plan\n");
    expect(items).toEqual([
      expect.objectContaining({
        nodeId: "code-review",
        state: "runnable",
        sourceColumn: "review",
        targetColumn: "review",
      }),
    ]);
    expect(String(items[0]?.runId)).toContain(":restart-stage:");
    expect(store.updateTask).toHaveBeenCalledWith("FN-209", expect.objectContaining({ externalBlock: null }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-209", "External-block resume retargeted: node implement belongs to an earlier column; restarting stage at code-review");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:external-block-cleared",
      metadata: expect.objectContaining({
        code: "ENOSPC",
        column: "review",
        resumeNodeId: "code-review",
        retargetedFromNodeId: "implement",
        outcome: "restart-stage",
      }),
    }));
  });

  it("signals the stale-node retarget without mutating the frozen card so the restart publisher owns every write", async () => {
    const row = blockedTask({ column: "review" });
    const before = structuredClone(row);
    const { store } = createStore(row);

    const result = await resumeExternallyBlockedTask({ store: store as never, taskId: row.id });

    expect(result).toEqual({ kind: "stale-node", frozenNodeId: "implement", entryNodeId: "code-review" });
    expect(row).toEqual(before);
    expect(row.externalBlock).toBeDefined();
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("keeps resume-at-node when the card moved backward since the freeze", async () => {
    const row = blockedTask({
      externalBlock: {
        ...blockedTask().externalBlock!,
        resume: { ...blockedTask().externalBlock!.resume, nodeId: "code-review" },
      },
    });
    const { store, items } = createStore(row);

    const result = await resumeExternallyBlockedTask({ store: store as never, taskId: row.id });

    expect(result).toMatchObject({ kind: "resumed", nodeId: "code-review" });
    expect(items).toEqual([
      expect.objectContaining({
        nodeId: "code-review",
        state: "runnable",
        sourceColumn: "building",
        targetColumn: "building",
      }),
    ]);
    expect(String(items[0]?.runId)).toContain(":external-block-resume:");
    expect(row.externalBlock).toBeNull();
  });

  it("refuses the retarget while a merge is live instead of restarting under a merger", async () => {
    const row = blockedTask({ column: "review" });
    const before = structuredClone(row);
    const { store, items } = createStore(row);

    await expect(republishExternalBlockResumeAsStageRestart({
      store: store as never,
      taskId: row.id,
      stale: { kind: "stale-node", frozenNodeId: "implement", entryNodeId: "code-review" },
      activeMergeTaskId: row.id,
    })).rejects.toThrow("Retry is unavailable while a merge is active");

    expect(row).toEqual(before);
    expect(items).toHaveLength(0);
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("refuses a retarget whose external block was already cleared by a concurrent retry", async () => {
    const row = blockedTask({ status: "failed", externalBlock: undefined, paused: undefined, pausedReason: undefined });
    const { store } = createStore(row);

    await expect(republishExternalBlockResumeAsStageRestart({
      store: store as never,
      taskId: row.id,
      stale: { kind: "stale-node", frozenNodeId: "implement", entryNodeId: "code-review" },
    })).rejects.toThrow("External-block Retry has already resumed this task");

    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
