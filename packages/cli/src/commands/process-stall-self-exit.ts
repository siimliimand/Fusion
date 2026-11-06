/**
 * FNXC:StallSelfExit 2026-11-06-12:05:
 * FIX-13 (KB-010, P0) — the self-recovery leg. The production engine on factory.webuilder.dev
 * wedged daily (2026-11-05 21:09–21:16 CET: node pinned at 110–112% CPU in GC thrash,
 * /api/health timing out at 45s, watchdogs force-opening every ~2 min) and stayed wedged until
 * an operator ran systemctl restart. Evidence capture (heap snapshots, event-loop-lag logs)
 * observes the wedge but cannot end it. This monitor is the bounded last resort AFTER evidence
 * capture has failed to prevent the wedge:
 *
 * Exit fires ONLY when ALL THREE legs hold on the same tick:
 *   1. Consecutive watchdog stall cycles >= maxConsecutiveStallCycles (default 5) — from the
 *      engine's shared RuntimeStallTracker (@fusion/engine). Any healthy watchdog pass resets
 *      that counter to 0, so a merely slow-but-progressing loop never accumulates cycles.
 *   2. /api/health failing on >= healthFailureTicksRequired (default 3) CONSECUTIVE monitor
 *      ticks — any healthy tick resets the failure counter, so a transient blip never exits.
 *   3. ZERO live work (no registered active sessions, no executing-task lock) — the durable-
 *      write fence. With zero registered sessions and zero executing locks, no merge, executor,
 *      planner, or land lease can be mid-flight, so exit(1) cannot truncate a durable DB write.
 *
 * Recovery contract: exit code 1 → systemd `Restart=on-failure` + `RestartSec=5` restarts
 * fusion.service → engine startup recovery reclaims in-flight work (proven on SUBC-016/021,
 * 2026-11-05). This replaces the human in the 2026-11-05 incident with minutes of outage
 * instead of hours. Self-exit NEVER replaces the operator fence "no hard MemoryMax" — it is
 * a process-level liveness recovery, not a resource-control decision.
 *
 * Every dep is injected so tests drive ticks deterministically with a mock exit fn.
 */
import type { DiagnosticsLogger } from "./process-diagnostics.js";

/** Injection seams — the dashboard wires the engine tracker, store health, and registry liveness. */
export type StallSelfExitDeps = {
  /** Consecutive watchdog force-open cycles from the engine RuntimeStallTracker. */
  getConsecutiveStallCycles: () => number;
  /** True when the (sync cached) health seam reports failure. Wired from the same store.healthCheck() the diagnostics use. */
  isHealthFailing: () => boolean;
  /** True when ANY active-session registry entry or executing-task lock exists. */
  hasLiveWork: () => boolean;
  /** Recent force-open evidence (source + epoch ms) for the exit evidence line; optional. */
  getRecentForceOpens?: () => ReadonlyArray<{ source: string; at: number }>;
  /** The command's logger — evidence lines follow the `[prefix] …` shape operators grep. */
  log: DiagnosticsLogger;
  /** Defaults to (code) => process.exit(code); tests inject a spy. */
  exit?: (code: number) => void;
};

export type StallSelfExitOptions = {
  /** Leg 1 threshold: exit requires at least this many consecutive stall cycles (default 5). */
  maxConsecutiveStallCycles?: number;
  /** Leg 2 threshold: exit requires health failing this many CONSECUTIVE ticks (default 3). */
  healthFailureTicksRequired?: number;
  /** Monitor cadence (default 60_000ms). */
  tickIntervalMs?: number;
  /** Log prefix for evidence lines (default "dashboard"). */
  prefix?: string;
  /** Test seam — defaults to process.memoryUsage (heap stats in the evidence line). */
  memoryUsage?: () => { rss?: number; heapUsed?: number; heapTotal?: number };
  /** Test seam — defaults to process uptime in ms. */
  uptimeMs?: () => number;
};

export type StallSelfExitMonitor = {
  /** Run one monitor tick synchronously (the interval calls this; tests drive it directly). */
  tickNow(): void;
  /** Clear the interval; further tickNow() calls are no-ops. */
  stop(): void;
};

function formatBytesShort(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
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

/**
 * Triple-gated stall self-exit monitor. Health failures count CONSECUTIVE ticks and reset to 0
 * on any healthy tick; the exit gate re-evaluates ALL THREE legs every tick (never latched), so
 * the exit fires the first tick the sustained wedge is provably work-free — never mid-durable-write.
 */
export function startStallSelfExitMonitor(deps: StallSelfExitDeps, options: StallSelfExitOptions = {}): StallSelfExitMonitor {
  const maxConsecutiveStallCycles = options.maxConsecutiveStallCycles ?? 5;
  const healthFailureTicksRequired = options.healthFailureTicksRequired ?? 3;
  const tickIntervalMs = options.tickIntervalMs ?? 60_000;
  const prefix = options.prefix ?? "dashboard";
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  const uptimeMs = options.uptimeMs ?? (() => Math.round(process.uptime() * 1000));

  let consecutiveHealthFailures = 0;
  let stopped = false;
  let exited = false;

  const tick = (): void => {
    if (stopped || exited) return;
    let stallCycles = 0;
    try {
      stallCycles = deps.getConsecutiveStallCycles();
    } catch {
      return; // tracker failure must never become a lifecycle dependency
    }
    const healthFailing = (() => {
      try {
        return deps.isHealthFailing();
      } catch {
        return true; // a throwing health check is a failing health check
      }
    })();
    consecutiveHealthFailures = healthFailing ? consecutiveHealthFailures + 1 : 0;

    let liveWork = true;
    try {
      liveWork = deps.hasLiveWork();
    } catch {
      liveWork = true; // ambiguous liveness refuses the exit — the durable-write fence
    }

    const cyclesLeg = stallCycles >= maxConsecutiveStallCycles;
    const healthLeg = consecutiveHealthFailures >= healthFailureTicksRequired;
    const livenessLeg = !liveWork;
    if (!(cyclesLeg && healthLeg && livenessLeg)) return;

    exited = true;
    const mem = memoryUsage();
    const recent = (() => {
      try {
        return deps.getRecentForceOpens?.() ?? [];
      } catch {
        return [];
      }
    })();
    const forceOpenSummary =
      recent.length > 0
        ? recent.map((e) => `${e.source}@${new Date(e.at).toISOString()}`).join(", ")
        : "none recorded";
    // One loud evidence line before exit: exactly what the operator (and post-mortem) needs.
    deps.log.warn(
      `[${prefix}] stall-self-exit: ${stallCycles} consecutive watchdog force-open cycles >= ${maxConsecutiveStallCycles}, ` +
        `health failing ${consecutiveHealthFailures} consecutive ticks >= ${healthFailureTicksRequired}, liveWork=false — ` +
        `recent force-opens: ${forceOpenSummary}; rss=${formatBytesShort(mem.rss)} heap=${formatBytesShort(mem.heapUsed)}/${formatBytesShort(mem.heapTotal)} ` +
        `uptime=${formatUptimeShort(uptimeMs())} — exiting code 1 for systemd Restart=on-failure to restart; startup recovery reclaims in-flight work`,
    );
    stop();
    exit(1);
  };

  const timer = setInterval(tick, tickIntervalMs);
  timer.unref?.(); // the monitor must never keep the process alive by itself

  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }

  return {
    tickNow: tick,
    stop,
  };
}
