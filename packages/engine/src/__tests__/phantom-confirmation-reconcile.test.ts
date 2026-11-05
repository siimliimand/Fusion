import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { EventEmitter } from "node:events";
import { recoverConfirmedMergePush } from "../merge/recover-confirmed-merge-push.js";
import * as pushRecoveryModule from "../merge/recover-confirmed-merge-push.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { SelfHealingManager } from "../self-healing.js";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";

/*
 * FNXC:MergeConfirmationReconcile 2026-11-05-21:01 (KB-005):
 * Extends the FIX-2 reconciliation contract to the shapes the operator contract names:
 * 1. Branch FALLBACK — a poisoned confirmation on a legacy row with NO recorded
 *    `mergeDetails.mergeTargetBranch` reconciles against the resolved project default, and a
 *    row with `task.baseBranch` reconciles against that branch (target-first precedence).
 * 2. LIVENESS FENCE — a poisoned confirmation is never reconciled while a session is actively
 *    working the card (registry path, executing lock, or the injected isTaskActive probe).
 * 3. FINALIZATION TRIGGER — a poisoned row whose finalization ends blocked still got the
 *    reconciliation pass (blocked never means wedged).
 * The git-layer end-to-end behavior (content-match, phantom un-confirm + re-open, bounded
 * exhaustion, merge-active guard, autoMerge:false allowance) is pinned in
 * merge/__tests__/recover-confirmed-merge-reconcile.test.ts and is not duplicated here.
 */

const execute = promisify(execFile);

let sequence = 0;

function fixtureTask(overrides: Partial<Task> = {}, mergeDetailsOverrides: Record<string, unknown> = {}): Task {
  return {
    id: "FN-KB005",
    column: "in-review",
    updatedAt: new Date(Date.now() + sequence++).toISOString(),
    mergeDetails: {
      mergeConfirmed: true,
      commitSha: "a".repeat(40),
      mergeTargetBranch: "main",
      ...mergeDetailsOverrides,
    },
    workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "failed", verdict: "REVISE" }],
    ...overrides,
  } as Task;
}

function fixtureStore(rootDir: string, task: Task, settings: Settings) {
  const store = {
    rootDir,
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => settings),
    updateTaskAtomic: vi.fn(async (_id: string, update: (live: Task) => Record<string, unknown> | null) => {
      const patch = update(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    listWorkflowWorkItemsForTask: vi.fn(async (): Promise<unknown[]> => []),
    getTaskWorkflowSelection: vi.fn(async () => undefined),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: Record<string, unknown>) => ({ id: "wi-1", ...input })),
    recordRunAuditEvent: vi.fn(async () => undefined),
  };
  return {
    raw: store as unknown as TaskStore,
    updateTaskAtomic: store.updateTaskAtomic,
    logEntry: store.logEntry,
    replaceActiveTaskWorkflowContinuation: store.replaceActiveTaskWorkflowContinuation,
    recordRunAuditEvent: store.recordRunAuditEvent,
  };
}

function reconcileAudits(
  recordRunAuditEvent: ReturnType<typeof vi.fn>,
  outcome?: string,
) {
  return recordRunAuditEvent.mock.calls
    .map(([event]) => event as { mutationType?: string; metadata?: Record<string, unknown> })
    .filter((event) => event.mutationType === "merge:confirmed-merge-reconciled")
    .filter((event) => !outcome || event.metadata?.outcome === outcome);
}

async function createFixtureRepo(): Promise<{ root: string; local: string }> {
  const root = await mkdtemp(join(tmpdir(), "fusion-phantom-reconcile-test-"));
  const local = join(root, "local");
  const git = async (args: string[], cwd = root) =>
    (await execute("git", args, { cwd, timeout: 15_000, encoding: "utf8" })).stdout.trim();
  await git(["init", "-b", "main", local]);
  await git(["config", "user.name", "Fusion Test"], local);
  await git(["config", "user.email", "fusion-test@example.test"], local);
  return { root, local };
}

async function gitCommit(local: string, file: string, content: string, message: string): Promise<string> {
  const git = async (args: string[]) =>
    (await execute("git", args, { cwd: local, timeout: 15_000, encoding: "utf8" })).stdout.trim();
  await writeFile(join(local, file), content);
  await git(["add", "-A"]);
  await git(["-c", "commit.gpgsign=false", "commit", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

describe("KB-005 phantom merge-confirmation reconciliation", () => {
  it("resolves a sole local branch by inference when origin/HEAD is unset (shell-quoted for-each-ref)", async () => {
    // FNXC:IntegrationBranchReadiness 2026-11-05-21:01 (KB-005):
    // The unquoted --format=%(refname:short) was a POSIX-shell syntax error, so the local
    // inference tiers always came back empty and every no-origin repo degraded to 'main'. This
    // tier is load-bearing for the reconcile fallback: a repo whose default is NOT main must
    // resolve its real default, or a HEALTHY confirmation would be reconciled as a phantom.
    const { root, local } = await createFixtureRepo();
    try {
      const git = async (args: string[], cwd = local) =>
        (await execute("git", args, { cwd, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      await gitCommit(local, "base.txt", "base\n", "base");
      await git(["branch", "-m", "main", "develop"]);
      await expect(resolveIntegrationBranch(local, {} as Settings)).resolves.toBe("develop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a poisoned row with no recorded target against the resolved project default", async () => {
    const { root, local } = await createFixtureRepo();
    try {
      const git = async (args: string[], cwd = local) =>
        (await execute("git", args, { cwd, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      await gitCommit(local, "base.txt", "base\n", "base");
      // Confirmed SHA exists as an object but is on NO branch (the SUBC-011 phantom shape).
      await git(["checkout", "-q", "-b", "fusion/fn-kb005"]);
      const phantomLandedSha = await gitCommit(local, "impl.txt", "impl\n", "task work");
      await git(["checkout", "-q", "main"]);
      await git(["update-ref", "-d", "refs/heads/fusion/fn-kb005"]);
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      // Legacy row: no recorded landing target, no task base branch.
      const task = fixtureTask({}, { commitSha: phantomLandedSha, mergeTargetBranch: undefined });
      const store = fixtureStore(local, task, settings);

      await recoverConfirmedMergePush(store.raw, task, settings);

      // Reconciled against the RESOLVED project default (main, inferred from the fixture repo).
      expect(task.mergeDetails?.mergeConfirmed).toBe(false);
      expect(task.mergeDetails?.commitSha).toBeUndefined();
      expect(task.mergeDetails?.reconciliation).toMatchObject({
        reason: "recorded-sha-not-on-target",
        recordedSha: phantomLandedSha,
      });
      expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
      const continuation = store.replaceActiveTaskWorkflowContinuation.mock.calls[0][0] as Record<string, unknown>;
      expect(continuation).toMatchObject({
        taskId: "FN-KB005",
        kind: "task",
        state: "runnable",
        sourceColumn: "in-review",
        targetColumn: "in-review",
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-KB005",
        "Auto-recovery: recorded landing SHA was never on main; merge re-opened",
      );
      expect(reconcileAudits(store.recordRunAuditEvent, "reopened")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a poisoned row against the task base branch when the recorded target is absent", async () => {
    const { root, local } = await createFixtureRepo();
    try {
      const git = async (args: string[], cwd = local) =>
        (await execute("git", args, { cwd, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      await gitCommit(local, "base.txt", "base\n", "base");
      await git(["branch", "release/1"]);
      await git(["checkout", "-q", "-b", "fusion/fn-kb005"]);
      const phantomLandedSha = await gitCommit(local, "impl.txt", "impl\n", "task work");
      await git(["checkout", "-q", "main"]);
      await git(["update-ref", "-d", "refs/heads/fusion/fn-kb005"]);
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask(
        { baseBranch: "release/1" },
        { commitSha: phantomLandedSha, mergeTargetBranch: undefined },
      );
      const store = fixtureStore(local, task, settings);

      await recoverConfirmedMergePush(store.raw, task, settings);

      // The task base branch wins the fallback chain over the resolved project default.
      expect(task.mergeDetails?.mergeConfirmed).toBe(false);
      expect(task.mergeDetails?.reconciliation).toMatchObject({ recordedSha: phantomLandedSha });
      expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-KB005",
        "Auto-recovery: recorded landing SHA was never on release/1; merge re-opened",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("KB-005 liveness-triple fence (poisoned row is a silent no-op while a session is live)", () => {
  /*
   * FNXC:MergeConfirmationReconcile 2026-11-05-21:01 (KB-005):
   * Each fence input of the canonical liveness triple must independently veto reconciliation:
   * a registered active session path, a held executing-task lock, or the injected isTaskActive
   * probe. In every case the poisoned row is untouched AND completely silent — no un-confirm, no
   * continuation, no reconcile audit row, no task log — so a re-invocation on the next tick is
   * naturally deduped (same silent eligibility return; the push-recovery cooldown map is never
   * reached). These use in-memory fakes with no real git: the veto fires at the entry gate.
   */
  const settings = { autoMerge: true, pushAfterMerge: true } as Settings;

  function poisonedFixture(): { task: Task; store: ReturnType<typeof fixtureStore> } {
    const task = fixtureTask();
    return { task, store: fixtureStore("/nonexistent-kb005-root", task, settings) };
  }

  function expectSilentNoOp(task: Task, store: ReturnType<typeof fixtureStore>): void {
    expect(task.mergeDetails?.mergeConfirmed).toBe(true);
    expect(task.mergeDetails?.commitSha).toBe("a".repeat(40));
    expect(task.mergeDetails?.reconciliation).toBeUndefined();
    expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    expect(reconcileAudits(store.recordRunAuditEvent)).toHaveLength(0);
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  }

  it("no-ops while an active session path is registered for the task", async () => {
    const { task, store } = poisonedFixture();
    const livePath = join(tmpdir(), `fusion-kb005-live-${Math.random().toString(36).slice(2)}`);
    activeSessionRegistry.registerPath(livePath, { taskId: "FN-KB005", kind: "executor", ownerKey: "kb005-test" });
    try {
      await recoverConfirmedMergePush(store.raw, task, settings);
      expectSilentNoOp(task, store);
    } finally {
      activeSessionRegistry.unregisterPath(livePath);
    }
  });

  it("no-ops while the executing task lock is held", async () => {
    const { task, store } = poisonedFixture();
    expect(executingTaskLock.tryClaim("FN-KB005")).toBe(true);
    try {
      await recoverConfirmedMergePush(store.raw, task, settings);
      expectSilentNoOp(task, store);
    } finally {
      executingTaskLock.release("FN-KB005");
    }
  });

  it("no-ops while the injected isTaskActive probe reports the task active", async () => {
    // The probe gates the RECONCILIATION predicate (push recovery keeps its own existing gates),
    // so this case uses a non-push-eligible card — the autoMerge:false population the sweep
    // reconciles — making the reconcile lane the only lane the entry can admit.
    const { task, store } = poisonedFixture();
    task.autoMerge = false;
    await recoverConfirmedMergePush(store.raw, task, settings, undefined, undefined, { isTaskActive: () => true });
    expectSilentNoOp(task, store);
    // The no-action dedup contract: a re-invocation on the next tick stays silent the same way.
    await recoverConfirmedMergePush(store.raw, task, settings, undefined, undefined, { isTaskActive: () => true });
    expectSilentNoOp(task, store);
  });
});

type SweepManager = SelfHealingManager & { reconcilePhantomMergeConfirmations(): Promise<number> };

/*
 * FNXC:PhantomConfirmationSweep 2026-11-05-21:01 (KB-005, FIX-2):
 * Sweep-harness store: mirrors the TaskStore surface the sweep and its callee read. `listTasks`
 * returns SLIM projections (distinct objects, mergeDetails kept — the slim contract), `getTask`
 * returns the canonical FULL row, so the wiring test can prove the sweep hands the callee a
 * non-slim task.
 */
function sweepStore(tasks: Task[], settings: Partial<Settings> = {}) {
  const byId = new Map<string, Task>(tasks.map((t) => [t.id, t] as [string, Task]));
  const store = Object.assign(new EventEmitter(), {
    rootDir: "/nonexistent-kb005-root",
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ...settings } as Settings)),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    listTasks: vi.fn(async () =>
      tasks.map((t) => ({ id: t.id, column: t.column, mergeDetails: t.mergeDetails }) as Task)),
    updateTaskAtomic: vi.fn(async (_id: string, update: (live: Task) => Record<string, unknown> | null) => {
      const current = byId.get(_id);
      if (!current) return null;
      const patch = update(current);
      if (patch) Object.assign(current, patch);
      return current;
    }),
    logEntry: vi.fn(async () => undefined),
    listWorkflowWorkItemsForTask: vi.fn(async (): Promise<unknown[]> => []),
    getTaskWorkflowSelection: vi.fn(async () => undefined),
    replaceActiveTaskWorkflowContinuation: vi.fn(async (input: Record<string, unknown>) => ({ id: "wi-1", ...input })),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter & {
    getTask: ReturnType<typeof vi.fn>;
    listTasks: ReturnType<typeof vi.fn>;
    logEntry: ReturnType<typeof vi.fn>;
    replaceActiveTaskWorkflowContinuation: ReturnType<typeof vi.fn>;
    recordRunAuditEvent: ReturnType<typeof vi.fn>;
  };
  return store;
}

function confirmedCard(id: string, overrides: Partial<Task> = {}): Task {
  return fixtureTask({ id, ...overrides });
}

describe("KB-005 self-healing phantom-confirmation sweep wiring", () => {
  it("invokes push recovery exactly once for the confirmed card with the FULL task, never for healthy cards", async () => {
    const confirmed = confirmedCard("FN-POISON");
    const healthy = fixtureTask({ id: "FN-HEALTHY", mergeDetails: { mergeConfirmed: false } });
    const store = sweepStore([confirmed, healthy]);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" }) as unknown as SweepManager;
    const spy = vi.spyOn(pushRecoveryModule, "recoverConfirmedMergePush").mockResolvedValue(undefined);
    try {
      const processed = await manager.reconcilePhantomMergeConfirmations();
      expect(processed).toBe(1);
      expect(store.listTasks).toHaveBeenCalledWith({ slim: true, includeArchived: false });
      expect(spy).toHaveBeenCalledTimes(1);
      const [calledStore, calledTask, calledSettings, runArg, fenceArg, livenessArg] = spy.mock.calls[0];
      expect(calledStore).toBe(store);
      // The FULL canonical row is handed over (slim rows may omit branchContext).
      expect(calledTask).toBe(confirmed);
      expect(calledSettings).toMatchObject({ globalPause: false });
      expect(runArg).toBeUndefined();
      expect(fenceArg).toBeUndefined();
      // The manager's isTaskActive probe (unset here) is forwarded as the liveness bag.
      expect(livenessArg).toEqual({ isTaskActive: undefined });
    } finally {
      spy.mockRestore();
    }
  });

  it("processes at most 5 candidates per tick", async () => {
    const tasks = [confirmedCard("FN-C1"), confirmedCard("FN-C2"), confirmedCard("FN-C3"), confirmedCard("FN-C4"), confirmedCard("FN-C5"), confirmedCard("FN-C6")];
    const store = sweepStore(tasks);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" }) as unknown as SweepManager;
    const spy = vi.spyOn(pushRecoveryModule, "recoverConfirmedMergePush").mockResolvedValue(undefined);
    try {
      const processed = await manager.reconcilePhantomMergeConfirmations();
      expect(processed).toBe(5);
      expect(spy).toHaveBeenCalledTimes(5);
      expect(spy.mock.calls.map((call) => (call[1] as Task).id)).toEqual(["FN-C1", "FN-C2", "FN-C3", "FN-C4", "FN-C5"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("skips entirely while the engine is paused", async () => {
    const store = sweepStore([confirmedCard("FN-POISON")], { globalPause: true });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" }) as unknown as SweepManager;
    const spy = vi.spyOn(pushRecoveryModule, "recoverConfirmedMergePush").mockResolvedValue(undefined);
    try {
      await expect(manager.reconcilePhantomMergeConfirmations()).resolves.toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("runs as a startup-recovery step and re-queues a poisoned card end to end", async () => {
    /*
     * FNXC:MergeConfirmationReconcile 2026-11-05-21:01 (KB-005):
     * Symptom acceptance (b), startup half: driving runStartupRecovery once over a seeded
     * poisoned card must end with the confirmation cleared and a runnable in-column continuation
     * seeded — no operator intervention. Other startup steps run too; they are individually
     * isolated and none of them reconciles this shape (that is exactly what was missing).
     */
    const { root, local } = await createFixtureRepo();
    try {
      const git = async (args: string[], cwd = local) =>
        (await execute("git", args, { cwd, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      await gitCommit(local, "base.txt", "base\n", "base");
      await git(["checkout", "-q", "-b", "fusion/fn-kb005"]);
      const phantomLandedSha = await gitCommit(local, "impl.txt", "impl\n", "task work");
      await git(["checkout", "-q", "main"]);
      await git(["update-ref", "-d", "refs/heads/fusion/fn-kb005"]);
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask({}, { commitSha: phantomLandedSha });
      const store = sweepStore([task], settings as Partial<Settings>);
      (store as unknown as { rootDir: string }).rootDir = local;
      const manager = new SelfHealingManager(store, { rootDir: local }) as unknown as SweepManager;

      await manager.runStartupRecovery();

      expect(task.mergeDetails?.mergeConfirmed).toBe(false);
      expect(task.mergeDetails?.commitSha).toBeUndefined();
      expect(task.mergeDetails?.reconciliation).toMatchObject({ recordedSha: phantomLandedSha });
      const continuations = store.replaceActiveTaskWorkflowContinuation.mock.calls
        .map(([input]) => input as Record<string, unknown>)
        .filter((input) => input.taskId === "FN-KB005");
      expect(continuations.length).toBeGreaterThanOrEqual(1);
      expect(continuations).toEqual([
        expect.objectContaining({ state: "runnable", sourceColumn: "in-review", targetColumn: "in-review" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("KB-005 self-healing sweep SYMPTOM ACCEPTANCE (real git)", () => {
  it("re-queues a poisoned card to merge without operator intervention", async () => {
    const { root, local } = await createFixtureRepo();
    try {
      const git = async (args: string[], cwd = local) =>
        (await execute("git", args, { cwd, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      await gitCommit(local, "base.txt", "base\n", "base");
      await git(["checkout", "-q", "-b", "fusion/fn-kb005"]);
      const phantomLandedSha = await gitCommit(local, "impl.txt", "impl\n", "task work");
      await git(["checkout", "-q", "main"]);
      await git(["update-ref", "-d", "refs/heads/fusion/fn-kb005"]);
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask({}, { commitSha: phantomLandedSha });
      const store = sweepStore([task], settings as Partial<Settings>);
      (store as unknown as { rootDir: string }).rootDir = local;
      const manager = new SelfHealingManager(store, { rootDir: local }) as unknown as SweepManager;

      const processed = await manager.reconcilePhantomMergeConfirmations();
      expect(processed).toBe(1);

      // THE OPERATOR CONTRACT: the poisoned card is re-queued to merge, no human in the loop.
      expect(task.mergeDetails?.mergeConfirmed).toBe(false);
      expect(task.mergeDetails?.commitSha).toBeUndefined();
      expect(task.mergeDetails?.reconciliation).toMatchObject({
        reason: "recorded-sha-not-on-target",
        recordedSha: phantomLandedSha,
      });
      expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
      const continuation = store.replaceActiveTaskWorkflowContinuation.mock.calls[0][0] as Record<string, unknown>;
      expect(continuation).toMatchObject({
        taskId: "FN-KB005",
        kind: "task",
        state: "runnable",
      });
      // In-column re-entry only — no backward column move.
      expect(continuation.sourceColumn).toBe(task.column);
      expect(continuation.targetColumn).toBe(task.column);
      const reopened = (store.recordRunAuditEvent.mock.calls
        .map(([event]) => event as { mutationType?: string; metadata?: Record<string, unknown> })
        .filter((event) => event.mutationType === "merge:confirmed-merge-reconciled"));
      expect(reopened).toHaveLength(1);
      expect(reopened[0].metadata).toMatchObject({ outcome: "reopened", branch: "main" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("KB-005 finalization-blocked trigger (blocked never means wedged)", () => {
  /*
   * FNXC:MergeConfirmationReconcile 2026-11-05-21:01 (KB-005):
   * SUBC-011's operator-visible shape: every finalization attempt logged
   * "merge-confirmed finalization blocked" and deferred forever because nothing reconciled the
   * poisoned confirmation. `finalizeProvenAutoMergeTask` already calls `recoverConfirmedMergePush`
   * before the evidence decision — this pins that the poisoned row is handed to reconciliation
   * EVEN WHEN finalization ends blocked (here: a pending post-merge evidence gate, which blocks
   * without being recovery-due). With interception the spy stands in for the real reconcile, whose
   * end-to-end behavior the other suites prove.
   */
  function finalizationFixture(): { task: Task; store: ReturnType<typeof sweepStore> } {
    const task = fixtureTask({
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "pending" }],
    });
    const selection = { workflowId: "builtin:coding", stepIds: ["post-merge-verification"] };
    const store = sweepStore([task]);
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => selection),
      getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    });
    return { task, store };
  }

  it("reconciles a poisoned confirmation even when finalization returns blocked", async () => {
    const { task, store } = finalizationFixture();
    const spy = vi.spyOn(pushRecoveryModule, "recoverConfirmedMergePush").mockResolvedValue(undefined);
    try {
      const finalization = await finalizeProvenAutoMergeTask({
        store,
        taskId: task.id,
        rootDir: "/nonexistent-kb005-root",
        source: "workflow-graph-merge-finalize",
      });

      // The pending post-merge gate still blocks the terminal move...
      expect(finalization.outcome).toBe("blocked");
      // ...but the poisoned row was handed to reconciliation first — the card is not wedged.
      expect(spy).toHaveBeenCalledTimes(1);
      const [, calledTask] = spy.mock.calls[0];
      expect(calledTask.id).toBe(task.id);
      expect(calledTask.mergeDetails?.mergeConfirmed).toBe(true);
      expect(calledTask.mergeDetails?.commitSha).toBe("a".repeat(40));
    } finally {
      spy.mockRestore();
    }
  });
});
