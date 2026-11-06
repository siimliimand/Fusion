import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startStallSelfExitMonitor,
  type StallSelfExitDeps,
  type StallSelfExitOptions,
} from "../process-stall-self-exit.js";
import type { DiagnosticsLogger } from "../process-diagnostics.js";
// FIX-13 (KB-010): the production wiring imports the tracker from @fusion/engine —
// this import in the CLI test proves the engine export path resolves from the CLI package.
import {
  noteWatchdogForceOpen,
  noteHealthyPass,
  getConsecutiveStallCycles,
  resetForTests,
} from "@fusion/engine";

/*
FNXC:StallSelfExit 2026-11-06-12:05 (FIX-13, KB-010):
Symptom-acceptance fixture leg for the stall self-recovery. The 2026-11-05 incident replay:
5 consecutive watchdog force-open cycles + failing health + zero live work must end in
exit(1) exactly once (systemd Restart=on-failure then restarts the unit). The negative
controls ARE the durable-write fence contract: 4 cycles, healthy health, or ANY live work
never exit; a mid-window health recovery resets the failure counter; a healthy watchdog pass
resetting the tracker below the cycle threshold blocks the exit even with sustained health
failures. All deps injected — no real timers, no real exit.
*/
function makeLogger() {
  const calls = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const logger: DiagnosticsLogger = {
    info: (m) => calls.info.push(m),
    warn: (m) => calls.warn.push(m),
    error: (m) => calls.error.push(m),
  };
  return { logger, calls };
}

type Fixture = {
  deps: StallSelfExitDeps;
  calls: ReturnType<typeof makeLogger>["calls"];
  exit: ReturnType<typeof vi.fn>;
  setCycles: (n: number) => void;
  setHealthFailing: (failing: boolean) => void;
  setLiveWork: (live: boolean) => void;
};

function makeFixture(overrides: Partial<StallSelfExitDeps> = {}): Fixture {
  const { logger, calls } = makeLogger();
  let cycles = 0;
  let healthFailing = false;
  let liveWork = false;
  const exit = vi.fn();
  const deps: StallSelfExitDeps = {
    getConsecutiveStallCycles: () => cycles,
    isHealthFailing: () => healthFailing,
    hasLiveWork: () => liveWork,
    getRecentForceOpens: () => [
      { source: "triage-poll", at: Date.parse("2026-11-05T20:09:00.000Z") },
      { source: "continuation-drain", at: Date.parse("2026-11-05T20:11:00.000Z") },
    ],
    log: logger,
    exit,
    ...overrides,
  };
  return {
    deps,
    calls,
    exit,
    setCycles: (n) => {
      cycles = n;
    },
    setHealthFailing: (failing) => {
      healthFailing = failing;
    },
    setLiveWork: (live) => {
      liveWork = live;
    },
  };
}

function start(fixture: Fixture, options: StallSelfExitOptions = {}) {
  return startStallSelfExitMonitor(fixture.deps, {
    memoryUsage: () => ({ rss: 2_200_000_000, heapUsed: 1_014_000_000, heapTotal: 1_000_000_000 }),
    uptimeMs: () => 7 * 60 * 1000,
    ...options,
  });
}

describe("stall self-exit monitor (triple gate)", () => {
  it("replays the incident: 5 cycles + health failing 3 ticks + no live work -> exit(1) exactly once with the evidence log", () => {
    const fx = makeFixture();
    fx.setCycles(5);
    fx.setHealthFailing(true);
    const monitor = start(fx);

    monitor.tickNow(); // health failure tick 1
    monitor.tickNow(); // health failure tick 2
    expect(fx.exit).not.toHaveBeenCalled();
    monitor.tickNow(); // health failure tick 3 -> all legs hold

    expect(fx.exit).toHaveBeenCalledTimes(1);
    expect(fx.exit).toHaveBeenCalledWith(1);
    const evidence = fx.calls.warn.filter((m) => m.includes("stall-self-exit"));
    expect(evidence).toHaveLength(1);
    // Evidence line carries what the operator needs: cycles, health ticks, live-work state,
    // force-open sources with timestamps, heap stats, and the recovery contract.
    expect(evidence[0]).toContain("5 consecutive watchdog force-open cycles");
    expect(evidence[0]).toContain("health failing 3 consecutive ticks");
    expect(evidence[0]).toContain("liveWork=false");
    expect(evidence[0]).toContain("triage-poll@");
    expect(evidence[0]).toContain("continuation-drain@");
    expect(evidence[0]).toContain("heap=");
    expect(evidence[0]).toContain("Restart=on-failure");

    // After exiting, further ticks never re-exit.
    monitor.tickNow();
    monitor.tickNow();
    expect(fx.exit).toHaveBeenCalledTimes(1);
  });

  it("4 cycles -> no exit even with 3+ failing health ticks and no live work", () => {
    const fx = makeFixture();
    fx.setCycles(4);
    fx.setHealthFailing(true);
    const monitor = start(fx);
    for (let i = 0; i < 5; i += 1) monitor.tickNow();
    expect(fx.exit).not.toHaveBeenCalled();
  });

  it("5 cycles + healthy health -> no exit (failure counter never accumulates)", () => {
    const fx = makeFixture();
    fx.setCycles(5);
    fx.setHealthFailing(false);
    const monitor = start(fx);
    for (let i = 0; i < 5; i += 1) monitor.tickNow();
    expect(fx.exit).not.toHaveBeenCalled();
  });

  it("5 cycles + health failing + ANY live work -> no exit (durable-write fence); exit fires only once live work clears", () => {
    const fx = makeFixture();
    fx.setCycles(5);
    fx.setHealthFailing(true);
    fx.setLiveWork(true);
    const monitor = start(fx);
    // Far more ticks than any threshold — the liveness leg must hold every tick.
    for (let i = 0; i < 8; i += 1) monitor.tickNow();
    expect(fx.exit).not.toHaveBeenCalled();

    // The gate is re-evaluated every tick (never latched): a wedge that outlives its work
    // still self-recovers once the fence clears.
    fx.setLiveWork(false);
    monitor.tickNow();
    expect(fx.exit).toHaveBeenCalledTimes(1);
    expect(fx.exit).toHaveBeenCalledWith(1);
  });

  it("health recovering mid-window resets the failure counter -> exit deferred to the 3rd CONSECUTIVE failure", () => {
    const fx = makeFixture();
    fx.setCycles(5);
    const monitor = start(fx);

    fx.setHealthFailing(true);
    monitor.tickNow(); // failure 1
    monitor.tickNow(); // failure 2
    fx.setHealthFailing(false);
    monitor.tickNow(); // healthy -> counter resets to 0
    fx.setHealthFailing(true);
    monitor.tickNow(); // failure 1 (again)
    monitor.tickNow(); // failure 2 — mid-window recovery deferred the exit
    expect(fx.exit).not.toHaveBeenCalled();

    monitor.tickNow(); // failure 3 (consecutive) -> exit
    expect(fx.exit).toHaveBeenCalledTimes(1);
  });

  it("a healthy pass resetting the tracker below the cycle threshold blocks exit despite sustained health failures", () => {
    const fx = makeFixture();
    fx.setHealthFailing(true);
    const monitor = start(fx);

    fx.setCycles(5);
    monitor.tickNow(); // failure 1
    monitor.tickNow(); // failure 2
    // Any healthy watchdog pass resets the engine tracker to 0 — recovery is happening.
    fx.setCycles(0);
    monitor.tickNow(); // failure 3, but cycle leg fails -> no exit
    monitor.tickNow(); // failure 4 -> no exit
    monitor.tickNow(); // failure 5 -> still no exit: cycles < threshold
    expect(fx.exit).not.toHaveBeenCalled();
  });

  it("stop() makes further ticks no-ops", () => {
    const fx = makeFixture();
    fx.setCycles(5);
    fx.setHealthFailing(true);
    const monitor = start(fx);
    monitor.stop();
    monitor.tickNow();
    monitor.tickNow();
    monitor.tickNow();
    expect(fx.exit).not.toHaveBeenCalled();
    expect(fx.calls.warn).toHaveLength(0);
  });

  it("the injected interval drives ticks (default 60s cadence, exit on 3rd tick)", () => {
    vi.useFakeTimers();
    try {
      const fx = makeFixture();
      fx.setCycles(5);
      fx.setHealthFailing(true);
      start(fx); // defaults: tickIntervalMs 60_000, healthFailureTicksRequired 3
      vi.advanceTimersByTime(2 * 60_000);
      expect(fx.exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(fx.exit).toHaveBeenCalledTimes(1);
      expect(fx.exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing health check counts as failing, and a throwing liveness probe refuses the exit", () => {
    const fx = makeFixture({
      isHealthFailing: () => {
        throw new Error("health seam exploded");
      },
      hasLiveWork: () => {
        throw new Error("registry probe exploded");
      },
    });
    fx.setCycles(5);
    const monitor = start(fx);
    for (let i = 0; i < 5; i += 1) monitor.tickNow();
    // Ambiguous liveness must refuse the exit — the durable-write fence wins ties.
    expect(fx.exit).not.toHaveBeenCalled();
  });
});

describe("engine tracker integration (import-path proof + real counter semantics)", () => {
  beforeEach(() => {
    resetForTests();
  });

  afterEach(() => {
    resetForTests();
  });

  it("the CLI resolves the engine export and the real tracker drives the exit gate", () => {
    expect(getConsecutiveStallCycles()).toBe(0);
    for (let i = 0; i < 5; i += 1) noteWatchdogForceOpen("triage-poll");
    expect(getConsecutiveStallCycles()).toBe(5);

    const fx = makeFixture({
      getConsecutiveStallCycles, // REAL engine tracker
    });
    fx.setHealthFailing(true);
    const monitor = start(fx);
    monitor.tickNow();
    monitor.tickNow();
    expect(fx.exit).not.toHaveBeenCalled();
    monitor.tickNow();
    expect(fx.exit).toHaveBeenCalledTimes(1);
  });

  it("a real healthy pass resets the real counter and blocks the exit", () => {
    for (let i = 0; i < 5; i += 1) noteWatchdogForceOpen("merge-queue");
    noteHealthyPass("merge-queue");
    expect(getConsecutiveStallCycles()).toBe(0);

    const fx = makeFixture({ getConsecutiveStallCycles });
    fx.setHealthFailing(true);
    const monitor = start(fx);
    for (let i = 0; i < 6; i += 1) monitor.tickNow();
    expect(fx.exit).not.toHaveBeenCalled();
  });
});
