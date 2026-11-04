import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { recoverConfirmedMergePush } from "../recover-confirmed-merge-push.js";
import { MAX_MERGE_CONFIRMATION_RECONCILE_ATTEMPTS } from "../recover-confirmed-merge-reconcile.js";

/*
 * FNXC:MergeConfirmationReconcile 2026-11-04-09:39:
 * SUBC-011 regression: `mergeDetails.mergeConfirmed=true` for a SHA that was never an ancestor of
 * main deferred finalization forever. These tests prove the reconciliation contract at the git and
 * store layer: healthy ancestor SHAs keep the unchanged push-recovery flow, same-content squash
 * landings are reconciled to the main-side SHA, true phantoms are un-confirmed and the merge is
 * re-opened IN-COLUMN through the sanctioned continuation writer, attempts are bounded with the
 * honest-blocked marker, and merge-active/paused/workspace cards are never touched.
 */

const phantomSha = "a".repeat(40);
const execute = promisify(execFile);

let sequence = 0;

function fixtureTask(overrides: Partial<Task> = {}, mergeDetailsOverrides: Record<string, unknown> = {}): Task {
  return {
    id: "FN-SUBC",
    column: "in-review",
    updatedAt: new Date(Date.now() + sequence++).toISOString(),
    mergeDetails: {
      mergeConfirmed: true,
      commitSha: phantomSha,
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

async function createFixtureRepo(): Promise<{ root: string; remote: string; local: string }> {
  const root = await mkdtemp(join(tmpdir(), "fusion-merge-reconcile-test-"));
  const remote = join(root, "remote.git");
  const local = join(root, "local");
  const git = async (args: string[], cwd = root) =>
    (await execute("git", args, { cwd, timeout: 15_000, encoding: "utf8" })).stdout.trim();
  await git(["init", "--bare", "--initial-branch=main", remote]);
  await git(["init", "-b", "main", local]);
  await git(["config", "user.name", "Fusion Test"], local);
  await git(["config", "user.email", "fusion-test@example.test"], local);
  return { root, remote, local };
}

async function gitCommit(local: string, file: string, content: string, message: string): Promise<string> {
  const git = async (args: string[]) =>
    (await execute("git", args, { cwd: local, timeout: 15_000, encoding: "utf8" })).stdout.trim();
  await writeFile(join(local, file), content);
  await git(["add", "-A"]);
  await git(["-c", "commit.gpgsign=false", "commit", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

describe("mergeConfirmed reconciliation (recorded SHA not on target)", () => {
  it("leaves the healthy path unchanged when the recorded SHA is an ancestor of the target", async () => {
    const { root, remote, local } = await createFixtureRepo();
    try {
      const landedSha = await gitCommit(local, "impl.txt", "impl\n", "landed work");
      await execute("git", ["remote", "add", "origin", remote], { cwd: local });
      await execute("git", ["push", "origin", "main"], { cwd: local });
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask({}, { commitSha: landedSha });
      const store = fixtureStore(local, task, settings);

      await recoverConfirmedMergePush(store.raw, task, settings);

      expect(await (await execute("git", ["rev-parse", "refs/heads/main"], { cwd: remote })).stdout.trim()).toBe(landedSha);
      expect(task.mergeDetails?.mergeConfirmed).toBe(true);
      expect(task.mergeDetails?.commitSha).toBe(landedSha);
      expect(task.mergeDetails?.pushRecovery?.pushedAt).toBeTruthy();
      expect(reconcileAudits(store.recordRunAuditEvent)).toHaveLength(0);
      expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a same-content squash landing to the main-side SHA and pushes it", async () => {
    const { root, remote, local } = await createFixtureRepo();
    try {
      const git = async (args: string[], cwd = local) =>
        (await execute("git", args, { cwd, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      const baseSha = await gitCommit(local, "base.txt", "base\n", "base");
      // The task branch carries the implementation; the recorded SHA is its tip.
      await git(["checkout", "-q", "-b", "fusion/fn-subc"]);
      const phantomLandedSha = await gitCommit(local, "impl.txt", "impl\n", "task work");
      // Main squash-lands the SAME content under a different SHA (the SUBC-011 manual repair shape).
      await git(["checkout", "-q", "main"]);
      const implTree = await git(["rev-parse", `${phantomLandedSha}^{tree}`]);
      const mainSideSha = await git(["commit-tree", implTree, "-p", baseSha, "-m", "squash landing of task work"]);
      await git(["reset", "--hard", mainSideSha]);
      await execute("git", ["remote", "add", "origin", remote], { cwd: local });
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask({}, { commitSha: phantomLandedSha });
      const store = fixtureStore(local, task, settings);

      await recoverConfirmedMergePush(store.raw, task, settings);

      // Landing proof now points at the real main-side commit and delivery proceeds with it.
      expect(task.mergeDetails?.mergeConfirmed).toBe(true);
      expect(task.mergeDetails?.commitSha).toBe(mainSideSha);
      expect(task.mergeDetails?.pushRecovery?.pushedAt).toBeTruthy();
      expect(await git(["rev-parse", "refs/heads/main"], remote)).toBe(mainSideSha);
      expect(reconcileAudits(store.recordRunAuditEvent, "content-match")).toHaveLength(1);
      expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-SUBC",
        expect.stringContaining("matches same-content commit"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("un-confirms a true phantom, re-opens the merge in-column, and completes a scripted re-landing", async () => {
    const { root, remote, local } = await createFixtureRepo();
    try {
      const git = async (args: string[], cwd = local) =>
        (await execute("git", args, { cwd, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      await gitCommit(local, "base.txt", "base\n", "base");
      // Confirmed SHA exists as an object but is on NO branch reachable from main (the phantom).
      await git(["checkout", "-q", "-b", "fusion/fn-subc"]);
      const phantomLandedSha = await gitCommit(local, "impl.txt", "impl\n", "task work");
      await git(["checkout", "-q", "main"]);
      await git(["update-ref", "-d", "refs/heads/fusion/fn-subc"]);
      await execute("git", ["remote", "add", "origin", remote], { cwd: local });
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask({}, { commitSha: phantomLandedSha });
      const store = fixtureStore(local, task, settings);

      await recoverConfirmedMergePush(store.raw, task, settings);

      // The false confirmation is cleared with the reconciliation record; the false SHA is gone.
      expect(task.mergeDetails?.mergeConfirmed).toBe(false);
      expect(task.mergeDetails?.commitSha).toBeUndefined();
      expect(task.mergeDetails?.reconciliation).toMatchObject({
        reason: "recorded-sha-not-on-target",
        recordedSha: phantomLandedSha,
      });
      expect(task.mergeDetails?.mergeConfirmationReconcileCount).toBe(1);
      expect(task.mergeDetails?.pushRecovery).toBeUndefined();
      // The merge is re-opened at the task's merge-region entry node, IN-COLUMN only.
      expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
      const continuation = store.replaceActiveTaskWorkflowContinuation.mock.calls[0][0] as Record<string, unknown>;
      expect(continuation).toMatchObject({
        taskId: "FN-SUBC",
        nodeId: "merge-gate",
        kind: "task",
        state: "runnable",
        sourceColumn: "in-review",
        targetColumn: "in-review",
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-SUBC",
        "Auto-recovery: recorded landing SHA was never on main; merge re-opened",
      );
      expect(reconcileAudits(store.recordRunAuditEvent, "reopened")).toHaveLength(1);

      // SYMPTOM VERIFICATION: a scripted landing after the re-open completes the loop with a NEW
      // landed SHA — the re-opened merge is drivable end to end (merger lands, proof reconciles).
      const reLandedSha = await gitCommit(local, "impl.txt", "impl re-landed with the re-opened merge\n", "re-opened merge lands the work");
      task.mergeDetails = {
        mergeConfirmed: true,
        commitSha: reLandedSha,
        mergeTargetBranch: "main",
      };
      task.updatedAt = new Date().toISOString();
      await recoverConfirmedMergePush(store.raw, task, settings);
      expect(await git(["rev-parse", "refs/heads/main"], remote)).toBe(reLandedSha);
      expect(task.mergeDetails?.pushRecovery?.pushedAt).toBeTruthy();
      expect(reconcileAudits(store.recordRunAuditEvent, "content-match")).toHaveLength(0);
      expect(reconcileAudits(store.recordRunAuditEvent, "reopened")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parks honestly once the re-open attempt budget is exhausted", async () => {
    const { root, local } = await createFixtureRepo();
    try {
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask({}, {
        commitSha: phantomSha,
        mergeConfirmationReconcileCount: MAX_MERGE_CONFIRMATION_RECONCILE_ATTEMPTS,
      });
      const store = fixtureStore(local, task, settings);

      await recoverConfirmedMergePush(store.raw, task, settings);

      expect(task.status).toBe("failed");
      expect(task.error).toBe(
        `MERGE-CONFIRMED RECONCILIATION EXHAUSTED: recorded SHA ${phantomSha} not on main after ${MAX_MERGE_CONFIRMATION_RECONCILE_ATTEMPTS} attempts`,
      );
      expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
      const exhausted = reconcileAudits(store.recordRunAuditEvent, "exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0].metadata).toMatchObject({
        taskId: "FN-SUBC",
        recordedSha: phantomSha,
        attempt: MAX_MERGE_CONFIRMATION_RECONCILE_ATTEMPTS,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never reconciles while a merge is active", async () => {
    const { root, local } = await createFixtureRepo();
    try {
      const git = async (args: string[]) =>
        (await execute("git", args, { cwd: local, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      await gitCommit(local, "impl.txt", "impl\n", "landed work");
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask({ status: "merging" }, { commitSha: phantomSha });
      const store = fixtureStore(local, task, settings);

      await recoverConfirmedMergePush(store.raw, task, settings);

      // The merge-active guard fires: no un-confirm, no reconciliation record, no re-open seeding,
      // and no reconcile audit — even though the ancestor check cannot prove the landing.
      expect(task.mergeDetails?.mergeConfirmed).toBe(true);
      expect(task.mergeDetails?.commitSha).toBe(phantomSha);
      expect(task.mergeDetails?.reconciliation).toBeUndefined();
      expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
      expect(reconcileAudits(store.recordRunAuditEvent)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles PR-based landing records the same way", async () => {
    const { root, local } = await createFixtureRepo();
    try {
      const git = async (args: string[]) =>
        (await execute("git", args, { cwd: local, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      await gitCommit(local, "base.txt", "base\n", "base");
      await git(["checkout", "-q", "-b", "fusion/fn-subc"]);
      const phantomLandedSha = await gitCommit(local, "impl.txt", "impl\n", "task work");
      await git(["checkout", "-q", "main"]);
      await git(["update-ref", "-d", "refs/heads/fusion/fn-subc"]);
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask({}, { commitSha: phantomLandedSha, prNumber: 42 });
      const store = fixtureStore(local, task, settings);

      await recoverConfirmedMergePush(store.raw, task, settings);

      expect(task.mergeDetails?.mergeConfirmed).toBe(false);
      expect(task.mergeDetails?.reconciliation?.recordedSha).toBe(phantomLandedSha);
      expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
      expect(reconcileAudits(store.recordRunAuditEvent, "reopened")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles autoMerge:false cards (restores pre-landing state) while keeping push recovery gated", async () => {
    const { root, local } = await createFixtureRepo();
    try {
      const git = async (args: string[]) =>
        (await execute("git", args, { cwd: local, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      await gitCommit(local, "base.txt", "base\n", "base");
      await git(["checkout", "-q", "-b", "fusion/fn-subc"]);
      const phantomLandedSha = await gitCommit(local, "impl.txt", "impl\n", "task work");
      await git(["checkout", "-q", "main"]);
      await git(["update-ref", "-d", "refs/heads/fusion/fn-subc"]);
      const settings = { autoMerge: false, pushAfterMerge: true } as Settings;
      const task = fixtureTask({ autoMerge: false }, { commitSha: phantomLandedSha });
      const store = fixtureStore(local, task, settings);

      await recoverConfirmedMergePush(store.raw, task, settings);

      // Reconciliation (un-confirm + re-open) runs despite autoMerge:false...
      expect(task.mergeDetails?.mergeConfirmed).toBe(false);
      expect(store.replaceActiveTaskWorkflowContinuation).toHaveBeenCalledTimes(1);
      // ...but no push ever happened: normal push recovery keeps its own gates.
      expect(store.logEntry.mock.calls.some((call) => String((call as unknown[])[0]).includes("available on"))).toBe(false);
      expect(reconcileAudits(store.recordRunAuditEvent, "reopened")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the legacy bookkeeping when the proof chain itself fails transiently", async () => {
    const { root, local } = await createFixtureRepo();
    try {
      const settings = { autoMerge: true, pushAfterMerge: true } as Settings;
      const task = fixtureTask();
      const store = fixtureStore(local, task, settings);
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === "merge-base") throw new Error("not an ancestor");
        if (args[0] === "rev-parse") throw new Error("git index corrupted");
        return "";
      });

      await recoverConfirmedMergePush(store.raw, task, settings, run as never);

      // A flaky git must never un-confirm a possibly-healthy landing: bookkeeping only.
      expect(task.mergeDetails?.mergeConfirmed).toBe(true);
      expect(task.mergeDetails?.commitSha).toBe(phantomSha);
      expect(task.mergeDetails?.pushRecovery?.error).toContain("not an ancestor");
      expect(store.replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
      expect(reconcileAudits(store.recordRunAuditEvent)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
