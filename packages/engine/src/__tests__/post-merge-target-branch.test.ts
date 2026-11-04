import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Task, TaskStore } from "@fusion/core";
import {
  emitMergeTargetBranchDivergence,
  resolveMergeConfirmedGateBranch,
  verifyMergeConfirmedReachability,
} from "../project-engine.js";
import { buildPostMergeLandingEvidenceContext } from "../executor/execute-workflow-step.js";
import { resumeMissingPostMergeGate } from "../merge/post-merge-gate-reseed.js";

/*
 * FNXC:PostMergeLandingTarget 2026-11-04-09:53 (FIX-11, SUBC-013):
 * Post-merge landing evidence must audit the RECORDED landing target branch, not the project
 * default. SUBC-013 (a mission task) landed on `mission/M-...` — recorded in
 * `mergeDetails.mergeTargetBranch` — yet the mergeConfirmed reachability check and the post-merge
 * verification step both resolved the project default (main), demanded the content there, and drove
 * a landed card into a permanent merge-confirmed limbo until an operator landed to main by hand.
 *
 * These tests exercise the gate against a real fixture repo: the mission branch holds the landed
 * commit while main does not, exactly the SUBC-013 shape.
 */

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

const created = new Set<string>();
afterEach(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.clear();
});

interface MissionRepo {
  dir: string;
  missionBranch: string;
  missionSha: string;
}

/**
 * A repo where `main` does NOT contain the task's landing: the task landed on a mission branch,
 * and main advanced past the fork point with unrelated work. This is the SUBC-013 geometry.
 */
function mkMissionRepo(): MissionRepo {
  const dir = mkdtempSync(join(testTempParent(), "fusion-test-post-merge-target-"));
  created.add(dir);
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "git add README.md");
  git(dir, 'git commit -m "chore: init"');
  const missionBranch = "mission/M-MW0Y99TK-0001-QM7G";
  git(dir, `git checkout -b ${missionBranch}`);
  writeFileSync(join(dir, "feature.txt"), "mission delivery\n");
  git(dir, "git add feature.txt");
  git(dir, 'git commit -m "feat(SUBC-013): mission work landed on the mission branch"');
  const missionSha = git(dir, "git rev-parse HEAD");
  git(dir, "git checkout main");
  writeFileSync(join(dir, "README.md"), "unrelated main work\n");
  git(dir, "git add README.md");
  git(dir, 'git commit -m "chore: unrelated main advance"');
  return { dir, missionBranch, missionSha };
}

function missionMergeDetails(missionSha: string, overrides: Record<string, unknown> = {}): Task["mergeDetails"] {
  return {
    mergeConfirmed: true,
    commitSha: missionSha,
    mergeTargetBranch: "mission/M-MW0Y99TK-0001-QM7G",
    mergedAt: "2026-11-04T09:00:00.000Z",
    ...overrides,
  } as Task["mergeDetails"];
}

describe("merge-confirmed reachability audits the recorded landing target (SUBC-013)", () => {
  it("approves a mission-branch landing that is absent from main — the reported regression", async () => {
    const { dir, missionBranch, missionSha } = mkMissionRepo();

    const gate = resolveMergeConfirmedGateBranch({
      recordedTargetBranch: missionBranch,
      taskBaseBranch: "main",
      projectDefaultBranch: "main",
    });
    expect(gate).toEqual({
      branch: missionBranch,
      source: "recorded-merge-target",
      divergedFromProjectDefault: true,
    });

    const reachability = await verifyMergeConfirmedReachability({
      commitSha: missionSha,
      integrationBranch: gate.branch,
      cwd: dir,
    });
    expect(reachability).toEqual({ reachable: true });

    // The pre-fix behavior: auditing the project default instead of the recorded target demanded
    // the mission content on main and refused the fast-path — the merge-confirmed limbo.
    const defaultFirst = await verifyMergeConfirmedReachability({
      commitSha: missionSha,
      integrationBranch: "main",
      cwd: dir,
    });
    expect(defaultFirst).toMatchObject({ reachable: false, reason: "not-ancestor" });
  });

  it("keeps the project-default fallback for rows without a recorded target", async () => {
    const { dir, missionSha } = mkMissionRepo();

    const fallback = resolveMergeConfirmedGateBranch({
      recordedTargetBranch: undefined,
      taskBaseBranch: undefined,
      projectDefaultBranch: "main",
    });
    expect(fallback).toEqual({ branch: "main", source: "project-default", divergedFromProjectDefault: false });

    // Legacy rows carried baseBranch before the resolved default — unchanged precedence.
    const legacy = resolveMergeConfirmedGateBranch({
      recordedTargetBranch: undefined,
      taskBaseBranch: "trunk",
      projectDefaultBranch: "main",
    });
    expect(legacy).toEqual({ branch: "trunk", source: "task-base-branch", divergedFromProjectDefault: false });

    const reachability = await verifyMergeConfirmedReachability({
      commitSha: missionSha,
      integrationBranch: fallback.branch,
      cwd: dir,
    });
    // The mission sha is genuinely absent from main: the fallback must still refuse it.
    expect(reachability).toMatchObject({ reachable: false, reason: "not-ancestor" });
  });

  it("lets a shared-branch-group reroute win while still flagging the recorded-target divergence", () => {
    const routed = resolveMergeConfirmedGateBranch({
      routedFastPathTarget: "fusion/bg-integration",
      recordedTargetBranch: "mission/M-MW0Y99TK-0001-QM7G",
      taskBaseBranch: "main",
      projectDefaultBranch: "main",
    });
    expect(routed.branch).toBe("fusion/bg-integration");
    expect(routed.source).toBe("branch-group-integration");
    expect(routed.divergedFromProjectDefault).toBe(true);
  });
});

describe("post-merge verification evidence context carries the landing target", () => {
  it("names the recorded mission branch, its tip, and the target-scoped completion criteria", async () => {
    const { dir, missionBranch, missionSha } = mkMissionRepo();
    const tip = git(dir, `git rev-parse refs/heads/${missionBranch}`);

    const context = await buildPostMergeLandingEvidenceContext({
      taskId: "SUBC-013",
      phase: "post-merge",
      task: { workspaceWorktrees: undefined, mergeDetails: missionMergeDetails(missionSha) } as Task,
      settings: { integrationBranch: "main" },
      rootDir: dir,
    });

    expect(context).toBeDefined();
    expect(context).toContain(`Landing reference branch: ${missionBranch} (recorded landing target of the merge)`);
    expect(context).toContain(`NOT on the project default branch (main)`);
    expect(context).toContain(`Current tip of ${missionBranch}: ${tip}`);
    expect(context).toContain(`Landed commit: ${missionSha}`);
    expect(context).toContain(`git merge-base --is-ancestor ${missionSha} ${missionBranch}`);
    expect(context).toContain(`first post-landing run on ${missionBranch}`);
    expect(context).not.toContain("first post-landing run on main");
  });

  it("covers a PR-based landing the same way: target recorded per landing wins over the default", async () => {
    const { dir, missionBranch, missionSha } = mkMissionRepo();
    const context = await buildPostMergeLandingEvidenceContext({
      taskId: "SUBC-013",
      phase: "post-merge",
      task: {
        workspaceWorktrees: undefined,
        mergeDetails: missionMergeDetails(missionSha, { prNumber: 41 }),
      } as Task,
      settings: { integrationBranch: "main" },
      rootDir: dir,
    });
    expect(context).toContain(`Landing reference branch: ${missionBranch}`);
    expect(context).toContain("NOT on the project default branch (main)");
  });

  it("falls back to the project default when no target is recorded", async () => {
    const { dir, missionSha } = mkMissionRepo();
    const context = await buildPostMergeLandingEvidenceContext({
      taskId: "FN-legacy",
      phase: "post-merge",
      task: {
        workspaceWorktrees: undefined,
        mergeDetails: { mergeConfirmed: true, commitSha: missionSha } as Task["mergeDetails"],
      } as Task,
      settings: { integrationBranch: "main" },
      rootDir: dir,
    });
    expect(context).toContain("Landing reference branch: main (project default; no divergent recorded landing target)");
    expect(context).not.toContain("NOT on the project default branch");
    expect(context).toContain("first post-landing run on main");
  });

  it("stays out of workspace per-repo landings and pre-merge phases", async () => {
    const { dir, missionSha } = mkMissionRepo();
    const workspace = await buildPostMergeLandingEvidenceContext({
      taskId: "FN-ws",
      phase: "post-merge",
      task: {
        workspaceWorktrees: { "repo-a": {} } as Task["workspaceWorktrees"],
        mergeDetails: missionMergeDetails(missionSha),
      } as unknown as Task,
      settings: { integrationBranch: "main" },
      rootDir: dir,
    });
    expect(workspace).toBeUndefined();

    const preMerge = await buildPostMergeLandingEvidenceContext({
      taskId: "FN-pre",
      phase: "pre-merge",
      task: { workspaceWorktrees: undefined, mergeDetails: missionMergeDetails(missionSha) } as Task,
      settings: { integrationBranch: "main" },
      rootDir: dir,
    });
    expect(preMerge).toBeUndefined();
  });
});

describe("merge:target-branch-divergence audit", () => {
  function auditStore(events: unknown[] = []): TaskStore {
    return {
      recordRunAuditEvent: vi.fn(async (input: unknown) => {
        events.push(input);
      }),
    } as unknown as TaskStore;
  }

  it("records ids-only divergence metadata when the recorded target differs from the default", async () => {
    const events: unknown[] = [];
    const store = auditStore(events);
    await emitMergeTargetBranchDivergence(store, {
      taskId: "SUBC-013-recorded",
      recordedTarget: "mission/M-MW0Y99TK-0001-QM7G",
      projectDefault: "main",
      outcome: "reachable",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mutationType: "merge:target-branch-divergence",
      agentId: "merger",
      target: "SUBC-013-recorded",
      metadata: {
        taskId: "SUBC-013-recorded",
        recordedTarget: "mission/M-MW0Y99TK-0001-QM7G",
        projectDefault: "main",
        outcome: "reachable",
      },
    });
  });

  it("deduplicates the divergence per gate signature while a distinct outcome emits again", async () => {
    const events: unknown[] = [];
    const store = auditStore(events);
    const args = {
      taskId: "SUBC-013-dedupe",
      recordedTarget: "mission/M-MW0Y99TK-0001-QM7G",
      projectDefault: "main",
      outcome: "reachable" as const,
    };
    await emitMergeTargetBranchDivergence(store, args);
    await emitMergeTargetBranchDivergence(store, args);
    await emitMergeTargetBranchDivergence(store, args);
    expect(events).toHaveLength(1);

    await emitMergeTargetBranchDivergence(store, { ...args, outcome: "not-reachable" });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ metadata: { outcome: "not-reachable" } });
  });

  it("is best-effort: a hostile sink never rejects the emitter", async () => {
    const store = {
      recordRunAuditEvent: () => {
        throw new Error("audit sink exploded");
      },
    };
    await expect(emitMergeTargetBranchDivergence(store, {
      taskId: "SUBC-013-hostile",
      recordedTarget: "mission/M-MW0Y99TK-0001-QM7G",
      projectDefault: "main",
      outcome: "reachable",
    })).resolves.toBeUndefined();
    await expect(emitMergeTargetBranchDivergence(null, {
      taskId: "SUBC-013-absent",
      recordedTarget: "mission/M-MW0Y99TK-0001-QM7G",
      projectDefault: "main",
      outcome: "reachable",
    })).resolves.toBeUndefined();
  });
});

describe("landed-verification routing is branch-independent (mission-target regression)", () => {
  /** Same fixture shape as confirmed-merge-must-finalize.test.ts, with a mission landing recorded. */
  function missionRecoveryFixture(missionSha: string) {
    const task = {
      id: "SUBC-013",
      column: "in-review",
      updatedAt: "2026-11-04T04:43:00.000Z",
      autoMerge: true,
      steps: [],
      mergeDetails: missionMergeDetails(missionSha),
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
    } as unknown as Task;
    const store = {
      getTask: vi.fn(async () => task),
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
      updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task> | Promise<Partial<Task>>) => Object.assign(task, await update(task))),
      moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
      logEntry: vi.fn(),
      recordRunAuditEvent: vi.fn(),
      getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
      getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
      listWorkflowWorkItemsForTask: vi.fn(async () => [] as unknown[]),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input: unknown) => ({ seeded: true, workItemId: input })),
    } as unknown as TaskStore & { seedWorkspaceCodeReviewContinuationIfIdle: ReturnType<typeof vi.fn> };
    return { task, store };
  }

  it("resumeMissingPostMergeGate resumes the post-merge gate for a mission-target row", async () => {
    const { dir, missionSha } = mkMissionRepo();
    const { task, store } = missionRecoveryFixture(missionSha);

    await expect(resumeMissingPostMergeGate(store, task.id)).resolves.toEqual({
      outcome: "resumed",
      gateId: "post-merge-verification",
    });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "post-merge-verification", state: "runnable" }),
    );
    expect(task.column).toBe("in-review");
    expect(task.mergeDetails?.mergeTargetBranch).toBe("mission/M-MW0Y99TK-0001-QM7G");
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});
