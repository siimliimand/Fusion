import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HEAP_PRESSURE_RATIO,
  createHeapPressureGate,
  createHeapPressureMonitor,
  isHeapReadingUnderPressure,
  startEventLoopLagMonitor,
  writeHeapSnapshotWithRetention,
  type DiagnosticsLogger,
} from "../process-diagnostics.js";

/*
FNXC:HeapPressureDiagnostics 2026-11-05-23:02 (FIX-13, KB-010):
Symptom-acceptance fixture leg. The production wedge operated silently at the V8 ceiling;
these tests pin the NEW contract: two consecutive over-ratio readings capture a snapshot
(writer injected — no real snapshots written), one transient reading does not, healthy boards
stay silent, retention keeps the newest 3, a >30s event-loop stall logs heap stats once, and
degenerate heapTotal readings can never divide-crash the tick.
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

describe("heap-pressure gate (pure)", () => {
  it("a reading is under pressure only above the ratio", () => {
    expect(HEAP_PRESSURE_RATIO).toBe(0.9);
    expect(isHeapReadingUnderPressure({ heapUsed: 91, heapTotal: 100 })).toBe(true);
    expect(isHeapReadingUnderPressure({ heapUsed: 90, heapTotal: 100 })).toBe(false);
    expect(isHeapReadingUnderPressure({ heapUsed: 89, heapTotal: 100 })).toBe(false);
  });

  it("divide-guards heapTotal 0, undefined, and non-finite", () => {
    expect(() => isHeapReadingUnderPressure({ heapUsed: 500, heapTotal: 0 })).not.toThrow();
    expect(isHeapReadingUnderPressure({ heapUsed: 500, heapTotal: 0 })).toBe(false);
    expect(() => isHeapReadingUnderPressure({ heapUsed: 500 })).not.toThrow();
    expect(isHeapReadingUnderPressure({ heapUsed: 500 })).toBe(false);
    expect(() => isHeapReadingUnderPressure(undefined)).not.toThrow();
    expect(() => isHeapReadingUnderPressure({ heapUsed: Number.NaN, heapTotal: 100 })).not.toThrow();
  });

  it("fires only on two consecutive under-pressure readings", () => {
    const gate = createHeapPressureGate();
    expect(gate.record({ heapUsed: 95, heapTotal: 100 }).fired).toBe(false);
    expect(gate.record({ heapUsed: 96, heapTotal: 100 }).fired).toBe(true);
    expect(gate.record({ heapUsed: 30, heapTotal: 100 }).fired).toBe(false);
    expect(gate.record({ heapUsed: 97, heapTotal: 100 }).fired).toBe(false);
    expect(gate.record({ heapUsed: 98, heapTotal: 100 }).fired).toBe(true);
  });

  it("first-ever reading can never fire (zero prior readings)", () => {
    const gate = createHeapPressureGate();
    expect(gate.record({ heapUsed: 99, heapTotal: 100 }).fired).toBe(false);
  });
});

describe("heap-pressure monitor (injected writer)", () => {
  it("two consecutive over-budget readings invoke the writer and log the path", () => {
    const { logger, calls } = makeLogger();
    const writtenPaths: string[] = [];
    const monitor = createHeapPressureMonitor({
      logger,
      prefix: "dashboard",
      getSnapshotsDir: () => "/tmp/fake-heapsnapshots",
      writeHeapSnapshot: (p) => {
        writtenPaths.push(p);
        return p;
      },
      now: () => Date.parse("2026-11-05T21:09:00.000Z"),
      pid: 4242,
    });
    monitor.recordReading({ heapUsed: 950, heapTotal: 1000 });
    expect(writtenPaths).toEqual([]);
    monitor.recordReading({ heapUsed: 960, heapTotal: 1000 });
    expect(writtenPaths.length).toBe(1);
    expect(writtenPaths[0]).toMatch(/heap-2026-11-05T21-09-00-000Z-pid4242\.heapsnapshot$/);
    const pathLine = calls.warn.find((l) => l.includes("heap snapshot written (evidence):"));
    expect(pathLine).toBeTruthy();
    expect(pathLine).toContain(writtenPaths[0]);
    // Path only — never contents.
    expect(calls.warn.every((l) => !l.includes("snapshot contents"))).toBe(true);
  });

  it("a single over-budget reading captures nothing", () => {
    const { logger } = makeLogger();
    const write = vi.fn(() => null);
    const monitor = createHeapPressureMonitor({
      logger,
      prefix: "dashboard",
      getSnapshotsDir: () => "/tmp/fake-heapsnapshots",
      writeHeapSnapshot: write,
    });
    monitor.recordReading({ heapUsed: 95, heapTotal: 100 });
    expect(write).not.toHaveBeenCalled();
  });

  it("healthy readings produce no snapshot and no heap-pressure logs", () => {
    const { logger, calls } = makeLogger();
    const write = vi.fn(() => null);
    const monitor = createHeapPressureMonitor({
      logger,
      prefix: "dashboard",
      getSnapshotsDir: () => "/tmp/fake-heapsnapshots",
      writeHeapSnapshot: write,
    });
    monitor.recordReading({ heapUsed: 300, heapTotal: 1000 });
    monitor.recordReading({ heapUsed: 320, heapTotal: 1000 });
    expect(write).not.toHaveBeenCalled();
    expect(calls.warn.filter((l) => l.includes("heap-pressure"))).toEqual([]);
  });

  it("an unresolved snapshots dir skips capture with an error line, never throws", () => {
    const { logger, calls } = makeLogger();
    const write = vi.fn(() => null);
    const monitor = createHeapPressureMonitor({
      logger,
      prefix: "dashboard",
      getSnapshotsDir: () => null,
      writeHeapSnapshot: write,
    });
    expect(() => {
      monitor.recordReading({ heapUsed: 95, heapTotal: 100 });
      monitor.recordReading({ heapUsed: 95, heapTotal: 100 });
    }).not.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(calls.error.some((l) => l.includes("snapshot directory not resolved"))).toBe(true);
  });

  it("writer failures are logged, never thrown", () => {
    const { logger, calls } = makeLogger();
    const monitor = createHeapPressureMonitor({
      logger,
      prefix: "dashboard",
      getSnapshotsDir: () => "/tmp/fake-heapsnapshots",
      writeHeapSnapshot: () => {
        throw new Error("boom");
      },
    });
    expect(() => {
      monitor.recordReading({ heapUsed: 95, heapTotal: 100 });
      monitor.recordReading({ heapUsed: 95, heapTotal: 100 });
    }).not.toThrow();
    expect(calls.error.some((l) => l.includes("capture failed"))).toBe(true);
  });

  it("a null writer return is logged as a failed capture", () => {
    const { logger, calls } = makeLogger();
    const monitor = createHeapPressureMonitor({
      logger,
      prefix: "dashboard",
      getSnapshotsDir: () => "/tmp/fake-heapsnapshots",
      writeHeapSnapshot: () => null,
    });
    monitor.recordReading({ heapUsed: 95, heapTotal: 100 });
    monitor.recordReading({ heapUsed: 95, heapTotal: 100 });
    expect(calls.error.some((l) => l.includes("returned no path"))).toBe(true);
  });
});

describe("snapshot retention (real tmp dir, injected writer)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb010-snapshots-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps the newest 3 snapshots and prunes older ones", () => {
    const seed = (name: string, mtimeMs: number) => {
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, "fake");
      fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    };
    const base = Date.now() - 100_000;
    seed("heap-old-1-pid1.heapsnapshot", base);
    seed("heap-old-2-pid1.heapsnapshot", base + 10_000);
    seed("heap-old-3-pid1.heapsnapshot", base + 20_000);
    seed("heap-old-4-pid1.heapsnapshot", base + 30_000);
    const { logger } = makeLogger();
    const written = writeHeapSnapshotWithRetention(tmpDir, 3, {
      writeHeapSnapshot: (p) => {
        fs.writeFileSync(p, "fake");
        return p;
      },
      pid: 99,
      logger,
    });
    expect(written).toBeTruthy();
    const remaining = fs.readdirSync(tmpDir).filter((n) => n.endsWith(".heapsnapshot")).sort();
    expect(remaining.length).toBe(3);
    expect(remaining.some((n) => n.includes("heap-old-1"))).toBe(false); // oldest pruned
    expect(remaining.some((n) => n.includes("pid99"))).toBe(true); // newest kept
  });

  it("retention keeps everything when under the cap", () => {
    const seed = (name: string) => fs.writeFileSync(path.join(tmpDir, name), "fake");
    seed("heap-a-pid1.heapsnapshot");
    seed("heap-b-pid1.heapsnapshot");
    const { logger } = makeLogger();
    writeHeapSnapshotWithRetention(tmpDir, 3, {
      writeHeapSnapshot: (p) => {
        fs.writeFileSync(p, "fake");
        return p;
      },
      pid: 5,
      logger,
    });
    const remaining = fs.readdirSync(tmpDir).filter((n) => n.endsWith(".heapsnapshot"));
    expect(remaining.length).toBe(3);
  });
});

describe("event-loop lag monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFakeHistogram(initialMaxNs: number) {
    /*
    FNXC:HeapPressureDiagnostics 2026-11-06-16:33: the fake's max is in NANOSECONDS — the real
    perf_hooks monitorEventLoopDelay IntervalHistogram contract. Injecting ms here is exactly the
    unit drift that let the first cut ship a >30µs gate as a >30s gate (production fired on any
    20ms GC pause and logged ns/1000 as "s"); these tests must use the production units so a
    future conversion regression fails loudly.
    */
    const hist = {
      max: initialMaxNs,
      resets: 0,
      enabled: false,
      disabled: false,
      reset() {
        hist.max = 0;
        hist.resets += 1;
      },
      enable() {
        hist.enabled = true;
      },
      disable() {
        hist.disabled = true;
      },
    };
    return hist;
  }

  it("a max lag sample above the threshold logs heap stats once and resets the histogram", () => {
    const { logger, calls } = makeLogger();
    const hist = makeFakeHistogram(31_500_000_000); // 31.5s in nanoseconds
    const monitor = startEventLoopLagMonitor({
      logger,
      prefix: "dashboard",
      histogramFactory: () => hist,
      memoryUsage: () => ({ rss: 1_800_000_000, heapUsed: 900_000_000, heapTotal: 1_000_000_000 }),
      uptimeMs: () => 7_380_000,
    });
    vi.advanceTimersByTime(10_000);
    const lagLines = calls.warn.filter((l) => l.includes("event-loop-lag"));
    expect(lagLines.length).toBe(1);
    expect(lagLines[0]).toContain("31.5s > 30s");
    expect(lagLines[0]).toContain("rss=");
    expect(lagLines[0]).toContain("heap=");
    expect(lagLines[0]).toContain("uptime=");
    expect(hist.resets).toBe(1);
    // After reset, silence until another over-threshold sample.
    vi.advanceTimersByTime(10_000);
    expect(calls.warn.filter((l) => l.includes("event-loop-lag")).length).toBe(1);
    monitor.stop();
  });

  it("a sample at or below the threshold is silent", () => {
    const { logger, calls } = makeLogger();
    const hist = makeFakeHistogram(5_000_000_000); // 5s in nanoseconds — healthy sub-threshold sample
    const monitor = startEventLoopLagMonitor({
      logger,
      prefix: "dashboard",
      histogramFactory: () => hist,
      memoryUsage: () => ({ rss: 1, heapUsed: 1, heapTotal: 1 }),
      uptimeMs: () => 0,
    });
    vi.advanceTimersByTime(30_000);
    expect(calls.warn.filter((l) => l.includes("event-loop-lag"))).toEqual([]);
    monitor.stop();
  });

  it("stop() disables the histogram and stops sampling", () => {
    const { logger, calls } = makeLogger();
    const hist = makeFakeHistogram(40_000_000_000); // 40s in nanoseconds
    const monitor = startEventLoopLagMonitor({
      logger,
      prefix: "dashboard",
      histogramFactory: () => hist,
      memoryUsage: () => ({ rss: 1, heapUsed: 1, heapTotal: 1 }),
      uptimeMs: () => 0,
    });
    monitor.stop();
    expect(hist.disabled).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(calls.warn.filter((l) => l.includes("event-loop-lag"))).toEqual([]);
  });
});
