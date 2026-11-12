/**
 * FNXC:BoardContextUsage 2026-11-12-10:59:
 * Covers the live per-task context-usage payload seam: the pure collector and
 * the TaskExecutor facade that reads it, which the GET /api/tasks board
 * enrichment consumes. Behavior-only assertions (wire shape, presence/absence,
 * normalization) — no comments or prose are asserted.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskContextUsageSnapshot, TaskStore } from "@fusion/core";
import { collectLiveTaskContextUsage, type LiveTaskContextUsageDeps } from "../executor/live-task-context-usage.js";
import { TaskExecutor } from "../executor.js";

function sessionWithUsage(usage: unknown) {
  return { getContextUsage: vi.fn(() => usage) };
}

function fakeUsage(overrides: Partial<{ tokens: number | null; contextWindow: number; percent: number | null }> = {}) {
  return { tokens: 214_000, contextWindow: 1_000_000, percent: 21.4, ...overrides };
}

describe("collectLiveTaskContextUsage", () => {
  function deps(overrides: Partial<LiveTaskContextUsageDeps> = {}): LiveTaskContextUsageDeps {
    return {
      activeSessions: new Map(),
      activeWorkflowStepSessions: new Map(),
      ...overrides,
    };
  }

  it("snapshots tokens, window, and rounded percent for a task with a live session", () => {
    const usage = collectLiveTaskContextUsage(deps({
      activeSessions: new Map([["FN-1", { session: sessionWithUsage(fakeUsage()) }]]),
    }));

    expect(usage.get("FN-1")).toEqual<TaskContextUsageSnapshot>({
      tokens: 214_000,
      contextWindow: 1_000_000,
      percent: 21,
    });
  });

  it("computes percent from tokens and window when pi reports percent as null", () => {
    const usage = collectLiveTaskContextUsage(deps({
      activeSessions: new Map([["FN-2", { session: sessionWithUsage(fakeUsage({ percent: null })) }]]),
    }));

    expect(usage.get("FN-2")?.percent).toBe(21);
  });

  it("omits a task whose session reports unknown occupancy (null tokens) instead of zero", () => {
    const usage = collectLiveTaskContextUsage(deps({
      activeSessions: new Map([["FN-3", { session: sessionWithUsage(fakeUsage({ tokens: null })) }]]),
    }));

    expect(usage.has("FN-3")).toBe(false);
  });

  it("omits a task with no session accessor, no usage, or a throwing accessor (best-effort)", () => {
    const usage = collectLiveTaskContextUsage(deps({
      activeSessions: new Map<string, unknown>([
        ["FN-4", {}],
        ["FN-5", { session: {} }],
        ["FN-6", { session: { getContextUsage: () => { throw new Error("boom"); } } }],
        ["FN-7", { session: sessionWithUsage(fakeUsage()) }],
      ]),
    }));

    expect([...usage.keys()]).toEqual(["FN-7"]);
  });

  it("omits malformed usage (non-finite or negative tokens, non-object usage)", () => {
    const usage = collectLiveTaskContextUsage(deps({
      activeSessions: new Map<string, unknown>([
        ["FN-8", { session: sessionWithUsage(fakeUsage({ tokens: Number.NaN })) }],
        ["FN-9", { session: sessionWithUsage(fakeUsage({ tokens: -5 })) }],
        ["FN-11", { session: sessionWithUsage("not-an-object") }],
      ]),
    }));

    expect(usage.size).toBe(0);
  });

  it("falls back to tokens-only when the model window is missing or invalid", () => {
    const usage = collectLiveTaskContextUsage(deps({
      activeSessions: new Map<string, unknown>([
        ["FN-10", { session: sessionWithUsage({ tokens: 10, contextWindow: 0 }) }],
        ["FN-10b", { session: sessionWithUsage({ tokens: 11 }) }],
      ]),
    }));

    expect(usage.get("FN-10")).toEqual<TaskContextUsageSnapshot>({ tokens: 10 });
    expect(usage.get("FN-10b")).toEqual<TaskContextUsageSnapshot>({ tokens: 11 });
  });

  it("prefers the task session over the workflow-step session for the same task", () => {
    const usage = collectLiveTaskContextUsage(deps({
      activeSessions: new Map([["FN-12", { session: sessionWithUsage(fakeUsage({ tokens: 1000 })) }]]),
      activeWorkflowStepSessions: new Map([["FN-12", sessionWithUsage(fakeUsage({ tokens: 999_999 }))]]),
    }));

    expect(usage.get("FN-12")?.tokens).toBe(1000);
  });

  it("snapshots workflow-step sessions for tasks with no task-level session", () => {
    const usage = collectLiveTaskContextUsage(deps({
      activeWorkflowStepSessions: new Map([["FN-13", sessionWithUsage(fakeUsage())]]),
    }));

    expect(usage.get("FN-13")?.tokens).toBe(214_000);
  });

  it("rounds truncation-safe token counts and clamps percent into 0..100", () => {
    const usage = collectLiveTaskContextUsage(deps({
      activeSessions: new Map([
        ["FN-14", { session: sessionWithUsage(fakeUsage({ tokens: 12.6, percent: 140 })) }],
      ]),
    }));

    expect(usage.get("FN-14")).toEqual<TaskContextUsageSnapshot>({ tokens: 12, contextWindow: 1_000_000, percent: 100 });
  });
});

/*
FNXC:BoardContextUsage 2026-11-12-10:59:
Facade-level proof: the executor method reads exactly the live session maps the
board enrichment depends on, and a stopped/empty executor yields an empty map
(idle tasks are absent, never fabricated).
*/
describe("TaskExecutor.getLiveTaskContextUsage", () => {
  function makeExecutor(): TaskExecutor {
    const store = Object.assign(new EventEmitter(), {
      logEntry: vi.fn().mockResolvedValue(undefined),
      getRunContextFor: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({}),
    }) as unknown as TaskStore;
    return new TaskExecutor(store, "/tmp/fusion-test-context-usage-root");
  }

  it("reads both live session surfaces through the public facade", () => {
    const executor = makeExecutor();
    (executor as unknown as { activeSessions: Map<string, unknown> }).activeSessions.set(
      "FN-20",
      { session: sessionWithUsage(fakeUsage()) },
    );
    (executor as unknown as { activeWorkflowStepSessions: Map<string, unknown> }).activeWorkflowStepSessions.set(
      "FN-21",
      sessionWithUsage(fakeUsage({ tokens: 42_000, percent: null })),
    );

    const usage = executor.getLiveTaskContextUsage();
    expect(usage.get("FN-20")?.tokens).toBe(214_000);
    expect(usage.get("FN-21")?.percent).toBe(4);
  });

  it("returns an empty map when no session is live", () => {
    expect(makeExecutor().getLiveTaskContextUsage().size).toBe(0);
  });
});
