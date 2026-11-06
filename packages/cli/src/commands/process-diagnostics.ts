/**
 * FNXC:HeapPressureDiagnostics 2026-11-05-23:02:
 * FIX-13 (KB-010, P0): the production engine repeatedly operates at the V8 old-space ceiling
 * (heap=1014MB/1.0GB observed 2026-11-05 20:10) and the resulting GC thrash pins the CPU until
 * /api/health times out and the process wedges until an operator restarts it. The 30-minute
 * diagnostics loop already prints memory numbers, but nothing WATCHES them. This module gives
 * the three CLI composition roots (dashboard/serve/daemon — the duplicated per-command loops)
 * one shared implementation of:
 *
 * 1. A pure heap-pressure gate: a reading is under pressure when heapUsed/heapTotal > 0.9
 *    (HEAP_PRESSURE_RATIO, divide-guarded), and pressure FIRES only when the current AND the
 *    previous reading are both under pressure — one transient spike must never snapshot.
 * 2. Retention-capped heap-snapshot capture: `.heapsnapshot` files under
 *    `<rootDir>/.fusion/diagnostics/heapsnapshots/` (directory mode 0700 — "root-only" means
 *    private to the fusion service user; `.fusion/` is already gitignored), filename
 *    `heap-<UTC-timestamp>-pid<pid>.heapsnapshot`, keep newest 3. All errors are logged and
 *    never thrown — diagnostics must never become a lifecycle dependency. Only the file PATH
 *    is ever logged: heap snapshots capture process memory and can contain credentials.
 * 3. An event-loop-lag monitor built on `perf_hooks.monitorEventLoopDelay` (near-zero cost —
 *    deliberately NOT the 50ms-polling FUSION_TRACE_EL_LAG debug tracer in dashboard.ts): when
 *    the max observed delay since the last reset exceeds 30s, log ONE warn line with heap
 *    stats so a stall has immediate evidence even between 30-minute diagnostics ticks.
 *
 * Security fence: snapshot contents are never logged, attached, or returned — callers surface
 * the path only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as v8 from "node:v8";
import { monitorEventLoopDelay } from "node:perf_hooks";

/** A reading is under heap pressure when heapUsed/heapTotal exceeds this ratio. */
export const HEAP_PRESSURE_RATIO = 0.9;

/** Minimal logger surface shared by all three CLI composition roots. */
export type DiagnosticsLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type MemoryReading = {
  heapUsed?: number;
  heapTotal?: number;
};

/**
 * Pure single-reading pressure check. Guarded against undefined / non-finite / zero
 * heapTotal so a degenerate reading can never divide-crash a diagnostics tick.
 */
export function isHeapReadingUnderPressure(reading: MemoryReading | undefined | null): boolean {
  if (!reading) return false;
  const { heapUsed, heapTotal } = reading;
  if (typeof heapUsed !== "number" || typeof heapTotal !== "number") return false;
  if (!Number.isFinite(heapUsed) || !Number.isFinite(heapTotal)) return false;
  if (heapTotal <= 0) return false;
  return heapUsed / heapTotal > HEAP_PRESSURE_RATIO;
}

/** Stateful consecutive gate: fires only when the current AND previous readings are under pressure. */
export type HeapPressureGate = {
  /** Record one reading; returns whether sustained pressure FIRED on this reading. */
  record(reading: MemoryReading | undefined | null): { fired: boolean };
  /** Clear remembered state (shutdown/tests). */
  reset(): void;
};

export function createHeapPressureGate(): HeapPressureGate {
  let previousUnderPressure = false;
  let hasPrevious = false;
  return {
    record(reading) {
      const under = isHeapReadingUnderPressure(reading);
      const fired = hasPrevious && under && previousUnderPressure;
      previousUnderPressure = under;
      hasPrevious = true;
      return { fired };
    },
    reset() {
      previousUnderPressure = false;
      hasPrevious = false;
    },
  };
}

/** Injection seams for writeHeapSnapshotWithRetention (tests supply the writer). */
export type HeapSnapshotWriteDeps = {
  /** Defaults to v8.writeHeapSnapshot(path); returns the written path or null on failure. */
  writeHeapSnapshot?: (snapshotPath: string) => string | null;
  /** Epoch-ms clock (tests freeze time). */
  now?: () => number;
  /** Process id baked into the filename (tests pin it). */
  pid?: number;
  /** Errors are logged here and never thrown. */
  logger?: DiagnosticsLogger;
};

/** Module-level re-entrancy guard: a second capture while one is in flight is skipped. */
let snapshotWriteInFlight = false;

/** Filename-safe UTC timestamp: 2026-11-05T22-58-51-123Z */
function filenameSafeUtcTimestamp(now: () => number): string {
  return new Date(now()).toISOString().replace(/[:.]/g, "-");
}

function isHeapSnapshotFile(name: string): boolean {
  return name.endsWith(".heapsnapshot");
}

function statTimeOrNameSort(a: fs.Dirent, b: fs.Dirent, dir: string): number {
  const timeOf = (entry: fs.Dirent): number => {
    try {
      return fs.statSync(path.join(dir, entry.name)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const aTime = timeOf(a);
  const bTime = timeOf(b);
  if (aTime !== bTime) return bTime - aTime; // newest first
  return b.name.localeCompare(a.name); // fallback: name desc (timestamp-prefixed names sort correctly)
}

/**
 * Write a `.heapsnapshot` into `snapshotsDir` (created recursive, mode 0700) and prune the
 * oldest snapshots beyond `keep` (default 3, newest kept). Re-entrant calls while a capture
 * is in flight are skipped. Every error is logged via `deps.logger` and swallowed — returns
 * the written path, or null when nothing was written.
 */
export function writeHeapSnapshotWithRetention(snapshotsDir: string, keep = 3, deps: HeapSnapshotWriteDeps = {}): string | null {
  const logger = deps.logger;
  if (snapshotWriteInFlight) {
    logger?.warn("heap-pressure: snapshot capture already in flight — skipping");
    return null;
  }
  snapshotWriteInFlight = true;
  try {
    fs.mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
    const snapshotPath = path.join(snapshotsDir, `heap-${filenameSafeUtcTimestamp(deps.now ?? Date.now)}-pid${deps.pid ?? process.pid}.heapsnapshot`);
    const write = deps.writeHeapSnapshot ?? ((p: string) => v8.writeHeapSnapshot(p));
    const written = write(snapshotPath);
    if (!written) {
      logger?.error(`heap-pressure: heap snapshot capture returned no path for ${snapshotPath}`);
      return null;
    }
    // Retention: keep the newest `keep` snapshots, prune older — bounded disk use.
    try {
      const entries = fs.readdirSync(snapshotsDir, { withFileTypes: true }).filter((e) => e.isFile() && isHeapSnapshotFile(e.name));
      if (entries.length > keep) {
        const sorted = entries.sort((a, b) => statTimeOrNameSort(a, b, snapshotsDir));
        for (const stale of sorted.slice(keep)) {
          try {
            fs.unlinkSync(path.join(snapshotsDir, stale.name));
          } catch (unlinkError) {
            logger?.error(`heap-pressure: failed to prune old snapshot ${stale.name}: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`);
          }
        }
      }
    } catch (pruneError) {
      logger?.error(`heap-pressure: snapshot retention prune failed: ${pruneError instanceof Error ? pruneError.message : String(pruneError)}`);
    }
    return written;
  } catch (error) {
    logger?.error(`heap-pressure: heap snapshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    snapshotWriteInFlight = false;
  }
}

/** Deps for the shared pressure monitor the three CLI loops hold as module state. */
export type HeapPressureMonitorDeps = {
  logger: DiagnosticsLogger;
  /** Log prefix, e.g. "dashboard" / "serve" / "daemon" — lines follow the `[prefix] diagnostics:` shape. */
  prefix: string;
  /**
   * Resolves the snapshot directory; null/undefined (root not known yet) skips capture with an
   * error log so a pressure event is still visible in the logs.
   */
  getSnapshotsDir: () => string | null | undefined;
  keep?: number;
  writeHeapSnapshot?: (snapshotPath: string) => string | null;
  now?: () => number;
  pid?: number;
};

export type HeapPressureMonitor = {
  /** Record one diagnostics-tick reading; captures + logs when sustained pressure fires. */
  recordReading(reading: MemoryReading | undefined | null): void;
  reset(): void;
};

function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/**
 * One shared sustained-pressure monitor for the three CLI composition roots. The gate decides
 * (two consecutive over-ratio readings); on fire it logs the warning, captures the snapshot
 * with retention, and logs the PATH ONLY — never the contents (snapshots contain credentials).
 */
export function createHeapPressureMonitor(deps: HeapPressureMonitorDeps): HeapPressureMonitor {
  const gate = createHeapPressureGate();
  return {
    recordReading(reading) {
      const { fired } = gate.record(reading);
      if (!fired) return;
      const heapUsed = typeof reading?.heapUsed === "number" ? reading.heapUsed : 0;
      const heapTotal = typeof reading?.heapTotal === "number" ? reading.heapTotal : 0;
      const ratio = heapTotal > 0 ? (heapUsed / heapTotal).toFixed(2) : "?";
      deps.logger.warn(
        `[${deps.prefix}] heap-pressure: heap=${formatBytesShort(heapUsed)}/${formatBytesShort(heapTotal)} (ratio ${ratio} > ${HEAP_PRESSURE_RATIO}) on two consecutive diagnostics readings — capturing heap snapshot`,
      );
      const dir = deps.getSnapshotsDir();
      if (!dir) {
        deps.logger.error(`[${deps.prefix}] heap-pressure: snapshot directory not resolved yet — capture skipped (evidence line above is the record)`);
        return;
      }
      const written = writeHeapSnapshotWithRetention(dir, deps.keep ?? 3, {
        writeHeapSnapshot: deps.writeHeapSnapshot,
        now: deps.now,
        pid: deps.pid,
        logger: deps.logger,
      });
      if (written) {
        // Path ONLY — never the contents: heap snapshots capture process memory (credentials).
        deps.logger.warn(
          `[${deps.prefix}] heap-pressure: heap snapshot written (evidence): ${written} — contains process memory; never commit, attach, or paste its contents`,
        );
      }
    },
    reset() {
      gate.reset();
    },
  };
}

/** Injection seams for startEventLoopLagMonitor (tests inject a fake histogram + clock). */
export type EventLoopLagHistogram = {
  /**
   * Max recorded delay in NANOSECONDS — the real `perf_hooks.monitorEventLoopDelay`
   * IntervalHistogram contract (FNXC:HeapPressureDiagnostics 2026-11-06-16:33: the first cut
   * compared this raw value against a millisecond threshold, so production fired at >30µs and
   * logged ns/1000 as "s" — off by 1e6 on both the gate and the evidence line; every lag
   * sample is converted to ms exactly once, here, before any comparison or formatting).
   */
  max: number;
  reset(): void;
  enable?(): void;
  disable?(): void;
};

export type EventLoopLagMonitorOptions = {
  logger: DiagnosticsLogger;
  prefix: string;
  /** Log when max observed loop delay since the last reset exceeds this (default 30_000ms). */
  lagThresholdMs?: number;
  /** Sample cadence (default 10_000ms). */
  sampleIntervalMs?: number;
  /** Defaults to perf_hooks.monitorEventLoopDelay({ resolution: 20 }); tests inject a fake. */
  histogramFactory?: () => EventLoopLagHistogram;
  /** Defaults to process.memoryUsage; tests inject. */
  memoryUsage?: () => { rss: number; heapUsed: number; heapTotal: number };
  /** Defaults to process uptime in ms; tests inject. */
  uptimeMs?: () => number;
};

export type EventLoopLagMonitor = {
  stop(): void;
};

/**
 * Near-zero-cost event-loop stall monitor. `monitorEventLoopDelay` observes without polling;
 * the interval only reads `histogram.max` and resets it. When max lag > threshold, log ONE
 * warn line with heap stats so an operator has immediate evidence of a >30s stall — the exact
 * GC-thrash signature of the daily wedge — even between diagnostics ticks.
 */
export function startEventLoopLagMonitor(options: EventLoopLagMonitorOptions): EventLoopLagMonitor {
  const lagThresholdMs = options.lagThresholdMs ?? 30_000;
  const sampleIntervalMs = options.sampleIntervalMs ?? 10_000;
  const histogram = options.histogramFactory
    ? options.histogramFactory()
    : (monitorEventLoopDelay({ resolution: 20 }) as unknown as EventLoopLagHistogram);
  histogram.enable?.();
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  const uptimeMs = options.uptimeMs ?? (() => Math.round(process.uptime() * 1000));
  const timer = setInterval(() => {
    try {
      // IntervalHistogram.max is nanoseconds; the threshold contract is milliseconds.
      const maxLagMs = histogram.max / 1e6;
      histogram.reset();
      if (maxLagMs <= lagThresholdMs) return;
      const mem = memoryUsage();
      options.logger.warn(
        `[${options.prefix}] event-loop-lag: max lag ${Math.round(maxLagMs / 100) / 10}s > ${Math.round(lagThresholdMs / 1000)}s threshold — ` +
          `rss=${formatBytesShort(mem.rss)} heap=${formatBytesShort(mem.heapUsed)}/${formatBytesShort(mem.heapTotal)} uptime=${formatUptimeShort(uptimeMs())}`,
      );
    } catch {
      /* diagnostics must never throw into the host loop */
    }
  }, sampleIntervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      try {
        histogram.disable?.();
      } catch {
        /* already disabled */
      }
    },
  };
}

function formatUptimeShort(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  return `${minutes}m${seconds % 60}s`;
}
