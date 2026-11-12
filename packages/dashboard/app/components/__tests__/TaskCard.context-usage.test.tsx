import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task, TaskContextUsageSnapshot } from "@fusion/core";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: () => null }));
vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("../RuntimeFallbackBadge", () => ({ RuntimeFallbackBadge: () => null }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));
vi.mock("../../api", () => ({
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

import { TaskCard } from "../TaskCard";

const noop = () => {};

/*
FNXC:BoardContextUsage 2026-11-12-10:59:
Board-rendering coverage for the live context-usage chip. Asserts the observable
contract on both breakpoints: one chip only while the engine attaches a live
snapshot (percent-of-window label, tokens-only fallback, warning tone, zero
occupancy), no chip shell at all when the field is absent (idle session), live
repaint between board fetches, and the shared mobile chip-height rule.
*/

function taskWithUsage(overrides: Partial<Task> & { contextUsage?: TaskContextUsageSnapshot } = {}): Task {
  return {
    id: "FN-9300",
    title: "Context usage fixture",
    description: "",
    column: "in-progress",
    steps: [{ name: "Implement", status: "in-progress" }] as Task["steps"],
    enabledWorkflowSteps: [],
    dependencies: [],
    ...overrides,
  } as Task;
}

describe("TaskCard context-usage chip", () => {
  it("renders one live chip with the percent-of-window label and truthful tooltip", () => {
    const { container } = render(
      <TaskCard
        task={taskWithUsage({ contextUsage: { tokens: 214_000, contextWindow: 1_000_000, percent: 21 } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const chips = container.querySelectorAll(".card-context-usage");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toContain("21%");
    expect(chips[0]?.getAttribute("data-context-usage-level")).toBe("normal");
    expect(chips[0]?.getAttribute("title")).toContain("214k of 1M tokens");
    expect(chips[0]?.getAttribute("title")).toContain("Live AI context");
  });

  it("labels by tokens only when the model window is not reported", () => {
    const { container } = render(
      <TaskCard task={taskWithUsage({ contextUsage: { tokens: 214_000 } })} onOpenDetail={noop} addToast={noop} />,
    );

    const chip = container.querySelector(".card-context-usage");
    expect(chip?.textContent).toContain("214k");
    expect(chip?.getAttribute("title")).toContain("214k tokens");
  });

  it("renders zero occupancy as an honest 0% live reading, not an absent chip", () => {
    const { container } = render(
      <TaskCard
        task={taskWithUsage({ contextUsage: { tokens: 0, contextWindow: 200_000, percent: 0 } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const chip = container.querySelector(".card-context-usage");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("0%");
  });

  it("flags warning tone at high occupancy", () => {
    const { container } = render(
      <TaskCard
        task={taskWithUsage({ contextUsage: { tokens: 920_000, contextWindow: 1_000_000, percent: 92 } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    expect(container.querySelector(".card-context-usage")?.getAttribute("data-context-usage-level")).toBe("warning");
  });

  it("renders no chip shell when the task has no live context usage", () => {
    const { container } = render(
      <TaskCard task={taskWithUsage()} onOpenDetail={noop} addToast={noop} />,
    );

    expect(container.querySelector(".card-context-usage")).toBeNull();
  });

  it("repaints the chip between board fetches (memo comparator owns the snapshot)", () => {
    const { container, rerender } = render(
      <TaskCard
        task={taskWithUsage({ contextUsage: { tokens: 100_000, contextWindow: 1_000_000, percent: 10 } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(container.querySelector(".card-context-usage")?.textContent).toContain("10%");

    rerender(
      <TaskCard
        task={taskWithUsage({ contextUsage: { tokens: 850_000, contextWindow: 1_000_000, percent: 85 } })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    const chip = container.querySelector(".card-context-usage");
    expect(chip?.textContent).toContain("85%");
    expect(chip?.getAttribute("data-context-usage-level")).toBe("warning");

    // Session went idle: the next complete board fetch omits the field, so the chip disappears.
    rerender(
      <TaskCard task={taskWithUsage()} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-context-usage")).toBeNull();
  });

  it("keeps the chip visible at the mobile breakpoint via the shared mobile chip-height rule", () => {
    const css = loadAllAppCss();
    expect(css).toMatch(
      /@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-time-indicator\s*,\s*\.card-cost-indicator\s*,\s*\.card-context-usage[\s\S]*?height:\s*var\(--card-chip-height-mobile\)/,
    );
    expect(css).not.toMatch(
      /@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-context-usage\s*\{[^}]*display:\s*none/,
    );
  });
});
