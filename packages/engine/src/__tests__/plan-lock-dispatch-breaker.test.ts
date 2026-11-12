import { describe, expect, it, vi } from "vitest";
import {
  computePlanLockSourceHash,
  formatPlanLockUnavailableDiagnostic,
  planEvidenceBindingsFromTask,
  type Task,
} from "@fusion/core";
import {
  findUnavailablePlanLockRejection,
  hasNoPostPlanReviewProgress,
  isPlanReviewBlockedByUnchangedPlanLockRejection,
  resolvePlanLockDispatchBreaker,
} from "../executor/plan-lock-dispatch-breaker.js";

/*
FNXC:SpecLockDispatchBreaker 2026-11-12-08:04:
The breaker must fire exactly on the degenerate shape the KB-001 loop exposed: a plan-review result
failed WITHOUT a verdict carrying a plan-lock parser rejection stamped with the current plan-input
hash, on a card that has produced no post-plan-review progress. Every other shape — a changed
prompt, a legacy unstamped row, an advanced card, a genuine REVISE, a non-plan step — must stay
inert so the breaker can never block legitimate graph entry.
*/

const HASH = "b".repeat(64);
const rejection = (overrides: Record<string, unknown> = {}) => ({
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  reviewKind: "plan",
  phase: "pre-merge",
  status: "failed",
  verdict: undefined,
  output: formatPlanLockUnavailableDiagnostic({ reason: "mission-missing", unavailableSections: ["mission"], sourceHash: HASH }),
  notes: undefined,
  ...overrides,
});

const taskWith = (workflowStepResults: unknown[]): Pick<Task, "workflowStepResults"> => ({ workflowStepResults } as Pick<Task, "workflowStepResults">);

describe("plan-lock dispatch breaker", () => {
  it("finds the deterministic plan-review rejection", () => {
    expect(findUnavailablePlanLockRejection(taskWith([rejection()]))).toBeDefined();
  });

  it("ignores a REVISE verdict, a non-plan step, and a transport-exhausted failure", () => {
    expect(findUnavailablePlanLockRejection(taskWith([rejection({ verdict: "REVISE" })]))).toBeUndefined();
    expect(findUnavailablePlanLockRejection(taskWith([rejection({ workflowStepId: "code-review", workflowStepName: "Code Review", reviewKind: "code" })]))).toBeUndefined();
    expect(findUnavailablePlanLockRejection(taskWith([rejection({ output: "Agent transport failed after retries", notes: undefined })]))).toBeUndefined();
  });

  it("blocks when the stamped input hash matches the live plan and no post-plan step has progressed", () => {
    const outcome = isPlanReviewBlockedByUnchangedPlanLockRejection(taskWith([rejection()]), HASH);
    expect(outcome).toMatchObject({ blocked: true, inputHash: HASH });
  });

  it("stays inert when the plan input changed (replan or operator edit)", () => {
    expect(isPlanReviewBlockedByUnchangedPlanLockRejection(taskWith([rejection()]), "c".repeat(64))).toMatchObject({ blocked: false });
  });

  it("stays inert on legacy rows written before input stamping", () => {
    const legacy = rejection({ output: "Plan approved but spec lock unavailable: mission-missing (mission)." });
    expect(isPlanReviewBlockedByUnchangedPlanLockRejection(taskWith([legacy]), HASH)).toMatchObject({ blocked: false });
  });

  it("stays inert once any other pre-merge step holds a terminal result", () => {
    const advanced = taskWith([rejection(), { workflowStepId: "code-review", phase: "pre-merge", status: "passed" }]);
    expect(hasNoPostPlanReviewProgress(advanced)).toBe(false);
    expect(isPlanReviewBlockedByUnchangedPlanLockRejection(advanced, HASH)).toMatchObject({ blocked: false });
  });

  it("blocks end-to-end against the live PROMPT.md artifact and its plan bindings", async () => {
    const prompt = "# Task\n\n## Mission\n\nBuild it.\n";
    const bindings = { dependencies: ["FN-7"], missionId: "m-1" };
    const stamped = rejection({
      output: formatPlanLockUnavailableDiagnostic({
        reason: "mission-missing",
        unavailableSections: ["mission"],
        sourceHash: computePlanLockSourceHash(prompt, planEvidenceBindingsFromTask(bindings)),
      }),
    });
    const task = { id: "FN-PLB", dependencies: bindings.dependencies, missionId: bindings.missionId, workflowStepResults: [stamped] } as unknown as Task;
    const readTaskArtifact = vi.fn().mockResolvedValue(prompt);
    const outcome = await resolvePlanLockDispatchBreaker({ readTaskArtifact }, task);
    expect(readTaskArtifact).toHaveBeenCalledWith("FN-PLB", "PROMPT.md");
    expect(outcome).toMatchObject({ blocked: true });
  });

  it("stays inert when the live prompt differs from the stamped input", async () => {
    const task = { id: "FN-PLB", workflowStepResults: [rejection()] } as unknown as Task;
    const readTaskArtifact = vi.fn().mockResolvedValue("# Task\n\n## Mission\n\nRewritten after replan.\n");
    expect(await resolvePlanLockDispatchBreaker({ readTaskArtifact }, task)).toMatchObject({ blocked: false });
  });

  it("stays inert when the artifact cannot be read", async () => {
    const readTaskArtifact = vi.fn().mockRejectedValue(new Error("store hiccup"));
    expect(await resolvePlanLockDispatchBreaker({ readTaskArtifact }, { id: "FN-PLB", workflowStepResults: [rejection()] } as Task)).toMatchObject({ blocked: false });
    const empty = vi.fn().mockResolvedValue("   ");
    expect(await resolvePlanLockDispatchBreaker({ readTaskArtifact: empty }, { id: "FN-PLB", workflowStepResults: [rejection()] } as Task)).toMatchObject({ blocked: false });
  });
});
