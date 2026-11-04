import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";

vi.mock("../worktree/review-diff-fingerprint.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree/review-diff-fingerprint.js")>("../worktree/review-diff-fingerprint.js");
  return {
    ...actual,
    computeCodeReviewInputFingerprint: vi.fn(async () => "a".repeat(64)),
    computeReviewDiffFingerprint: vi.fn(async () => "a".repeat(64)),
    resolveContentReviewInputProof: vi.fn(async () => ({ kind: "fingerprint", fingerprint: "a".repeat(64) })),
  };
});

import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";

/*
 * FNXC:PostMergeLandingTarget 2026-11-04-09:53 (FIX-11, SUBC-013):
 * The post-merge verification step's evidence context must name the RECORDED landing target
 * branch so the verifier audits the landing there instead of the project default. SUBC-013's
 * reviewer audited main ("fb4586f is not an ancestor of main") for a landing recorded against a
 * mission branch. These tests prove the landing context reaches the step's system prompt through
 * the real executeWorkflowStep path.
 */

function task(mergeDetails: Record<string, unknown> | undefined) {
  return {
    id: "SUBC-013",
    title: "Mission delivery",
    description: "Already merged",
    column: "in-review",
    worktree: process.cwd(),
    branch: "fusion/subc-013",
    baseCommitSha: "HEAD",
    dependencies: [],
    steps: [{ name: "Testing & Verification", status: "done" }],
    currentStep: 0,
    log: [],
    mergeDetails,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  } as any;
}

function step(phase: "post-merge" | "pre-merge") {
  return {
    id: phase === "post-merge" ? "post-merge-verification-step" : "graph:code-review",
    name: phase === "post-merge" ? "Post-merge verification" : "Code Review",
    description: "",
    mode: "prompt",
    phase,
    gateMode: "gate",
    prompt: "Verify the landed result.",
    toolMode: "readonly",
    enabled: true,
    optionalGroupId: phase === "post-merge" ? "post-merge-verification" : "code-review",
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  } as any;
}

function installReviewer() {
  mockedCreateFnAgent.mockImplementation(async () => ({
    session: {
      state: {},
      dispose: vi.fn(),
    },
  }) as any);
}

async function runStep(phase: "post-merge" | "pre-merge", mergeDetails: Record<string, unknown> | undefined) {
  installReviewer();
  const subject = task(mergeDetails);
  const store = createMockStore();
  store.getTask.mockImplementation(async () => subject);
  const executor = new TaskExecutor(store as any, process.cwd());
  vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue("# Approved plan\n");
  await (executor as any).executeWorkflowStep(subject, step(phase), process.cwd(), {});
  const sessionOptions = mockedCreateFnAgent.mock.calls.at(-1)?.[0] as { systemPrompt?: string } | undefined;
  return sessionOptions?.systemPrompt ?? "";
}

const MISSION_SHA = "b7c1e2a4d9b7c1e2a4d9b7c1e2a4d9b7c1e2a4d9";

describe("post-merge step receives the landing-target evidence context", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("audits a mission-branch landing on the recorded target, not the project default", async () => {
    const systemPrompt = await runStep("post-merge", {
      mergeConfirmed: true,
      commitSha: MISSION_SHA,
      mergeTargetBranch: "mission/M-MW0Y99TK-0001-QM7G",
    });

    expect(systemPrompt).toContain("Landing Evidence Context (post-merge)");
    expect(systemPrompt).toContain("Landing reference branch: mission/M-MW0Y99TK-0001-QM7G");
    expect(systemPrompt).toContain("NOT on the project default branch (main)");
    expect(systemPrompt).toContain(`Landed commit: ${MISSION_SHA}`);
    expect(systemPrompt).toContain(`git merge-base --is-ancestor ${MISSION_SHA} mission/M-MW0Y99TK-0001-QM7G`);
  });

  it("keeps the project-default reference for rows without a recorded target", async () => {
    const systemPrompt = await runStep("post-merge", { mergeConfirmed: true, commitSha: MISSION_SHA });

    expect(systemPrompt).toContain("Landing Evidence Context (post-merge)");
    expect(systemPrompt).toContain("Landing reference branch: main (project default; no divergent recorded landing target)");
    expect(systemPrompt).not.toContain("NOT on the project default branch");
  });

  it("does not add a landing context to pre-merge steps", async () => {
    const systemPrompt = await runStep("pre-merge", {
      mergeConfirmed: true,
      commitSha: MISSION_SHA,
      mergeTargetBranch: "mission/M-MW0Y99TK-0001-QM7G",
    });

    expect(systemPrompt).not.toContain("Landing Evidence Context (post-merge)");
  });
});
