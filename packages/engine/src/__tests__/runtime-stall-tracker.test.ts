import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConsecutiveStallCycles,
  getRecentForceOpens,
  noteHealthyPass,
  noteWatchdogForceOpen,
  resetForTests,
} from "../util/runtime-stall-tracker.js";

/*
FNXC:RuntimeStallTracker 2026-11-05-22:58:
FIX-13 (KB-010) contract tests. The CLI stall self-exit monitor gates process.exit(1) on
getConsecutiveStallCycles() >= 5, so the counter semantics ARE the safety contract:
force-opens increment, ANY healthy pass from ANY source resets, the evidence ring stays
bounded, and tests never leak module state into each other.
*/
describe("runtime stall tracker", () => {
  beforeEach(() => {
    resetForTests();
  });

  afterEach(() => {
    resetForTests();
  });

  it("increments the consecutive counter per force-open", () => {
    noteWatchdogForceOpen("triage-poll");
    expect(getConsecutiveStallCycles()).toBe(1);
    noteWatchdogForceOpen("continuation-drain");
    noteWatchdogForceOpen("merge-queue");
    expect(getConsecutiveStallCycles()).toBe(3);
  });

  it("keeps counting across different sources (a wedge fires all watchdogs)", () => {
    noteWatchdogForceOpen("triage-poll");
    noteWatchdogForceOpen("triage-poll");
    noteWatchdogForceOpen("continuation-drain");
    noteWatchdogForceOpen("merge-queue");
    noteWatchdogForceOpen("dispatch-schedule");
    expect(getConsecutiveStallCycles()).toBe(5);
  });

  it("a healthy pass from any source resets the counter to 0", () => {
    noteWatchdogForceOpen("triage-poll");
    noteWatchdogForceOpen("triage-poll");
    noteHealthyPass("dispatch-schedule");
    expect(getConsecutiveStallCycles()).toBe(0);
  });

  it("interleaved ordering: F,F,healthy,F stays 1", () => {
    noteWatchdogForceOpen("triage-poll");
    noteWatchdogForceOpen("triage-poll");
    noteHealthyPass("merge-queue");
    noteWatchdogForceOpen("triage-poll");
    expect(getConsecutiveStallCycles()).toBe(1);
  });

  it("five force-opens with no healthy pass stay 5 (the self-exit threshold leg)", () => {
    for (let i = 0; i < 5; i++) {
      noteWatchdogForceOpen("triage-poll");
    }
    expect(getConsecutiveStallCycles()).toBe(5);
  });

  it("repeated healthy passes keep the counter at 0", () => {
    noteHealthyPass("triage-poll");
    noteHealthyPass("continuation-drain");
    noteHealthyPass("merge-queue");
    expect(getConsecutiveStallCycles()).toBe(0);
  });

  it("records force-open evidence with source and timestamp", () => {
    const before = Date.now();
    noteWatchdogForceOpen("triage-poll");
    const events = getRecentForceOpens();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last.source).toBe("triage-poll");
    expect(last.at).toBeGreaterThanOrEqual(before);
    expect(last.at).toBeLessThanOrEqual(Date.now());
  });

  it("caps the evidence ring at 10 entries, keeping the newest", () => {
    for (let i = 0; i < 25; i++) {
      noteWatchdogForceOpen(`source-${i}`);
    }
    const events = getRecentForceOpens();
    expect(events.length).toBe(10);
    expect(events[0].source).toBe("source-15");
    expect(events[9].source).toBe("source-24");
  });

  it("recovery markers do not crowd force-open evidence out of the ring", () => {
    noteWatchdogForceOpen("triage-poll");
    noteHealthyPass("merge-queue");
    const events = getRecentForceOpens();
    expect(events.some((e) => e.source === "triage-poll")).toBe(true);
    expect(events.some((e) => e.source === "merge-queue:recovered")).toBe(true);
  });

  it("getRecentForceOpens returns a copy the caller cannot mutate through", () => {
    noteWatchdogForceOpen("triage-poll");
    const events = getRecentForceOpens();
    (events as Array<{ source: string; at: number }>).push({ source: "tampered", at: 0 });
    expect(getRecentForceOpens().some((e) => e.source === "tampered")).toBe(false);
  });

  it("resetForTests clears counter and evidence", () => {
    noteWatchdogForceOpen("triage-poll");
    noteWatchdogForceOpen("merge-queue");
    resetForTests();
    expect(getConsecutiveStallCycles()).toBe(0);
    expect(getRecentForceOpens()).toEqual([]);
  });
});
