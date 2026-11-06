/**
 * FNXC:RuntimeStallTracker 2026-11-05-22:58:
 * FIX-13 (KB-010, P0): the engine on factory.webuilder.dev wedged daily because the V8 heap
 * saturated (~1.0GB budget) and GC thrash pinned the CPU at ~110% while /api/health timed out.
 * Every watchdog (triage poll, continuation drain, merge queue, dispatch schedule) kept force-
 * opening its re-entrance guard every ~2 minutes — recovery was impossible without an operator.
 * The monitor that ends the process when that state repeats needs SHARED evidence of "how many
 * consecutive watchdog force-open cycles have fired with no healthy pass in between", so this
 * process-singleton counts them across all four sources.
 *
 * Counter semantics (the contract the self-exit monitor depends on):
 * - `noteWatchdogForceOpen(source)` increments the consecutive-stall-cycle counter and records
 *   the event in a bounded ring (newest last) for the evidence log.
 * - `noteHealthyPass(source)` resets the counter to 0. ANY healthy pass from ANY watchdog source
 *   resets, because a real wedge fires ALL watchdogs together, while recovery shows normal
 *   passes proceeding — one healthy pump anywhere proves the event loop is servicing work.
 * - `getConsecutiveStallCycles()` is the value the self-exit gate compares against its threshold.
 *
 * Deliberately stateless beyond module state: no store, no timers, no imports at all. The
 * tracker is silent (the existing force-open log lines at each call site already carry the
 * operator-visible signal) so it can be called from every pump without log noise or a
 * lifecycle dependency.
 */

/** A watchdog force-open evidence event (bounded ring entry). */
export type WatchdogForceOpenEvent = {
  /** Stable source id: "triage-poll" | "continuation-drain" | "merge-queue" | "dispatch-schedule". */
  source: string;
  /** Epoch ms when the force-open happened. */
  at: number;
};

/** Maximum evidence events retained — enough to reconstruct a wedge, bounded so it can never grow. */
const FORCE_OPEN_RING_CAPACITY = 10;

let consecutiveStallCycles = 0;
const forceOpenRing: WatchdogForceOpenEvent[] = [];

/** Record one watchdog force-open: consecutive-stall counter +1, evidence appended to the ring. */
export function noteWatchdogForceOpen(source: string): void {
  consecutiveStallCycles += 1;
  forceOpenRing.push({ source, at: Date.now() });
  if (forceOpenRing.length > FORCE_OPEN_RING_CAPACITY) {
    forceOpenRing.splice(0, forceOpenRing.length - FORCE_OPEN_RING_CAPACITY);
  }
}

/** Record one normal (non-forced) guard pass: ANY source resets the consecutive counter to 0. */
export function noteHealthyPass(source: string): void {
  if (consecutiveStallCycles > 0) {
    forceOpenRing.push({ source: `${source}:recovered`, at: Date.now() });
    if (forceOpenRing.length > FORCE_OPEN_RING_CAPACITY) {
      forceOpenRing.splice(0, forceOpenRing.length - FORCE_OPEN_RING_CAPACITY);
    }
  }
  consecutiveStallCycles = 0;
}

/** How many watchdog force-open cycles have fired consecutively (any healthy pass resets to 0). */
export function getConsecutiveStallCycles(): number {
  return consecutiveStallCycles;
}

/** Read-only copy of recent force-open evidence (newest last) for the self-exit evidence log. */
export function getRecentForceOpens(): readonly WatchdogForceOpenEvent[] {
  return forceOpenRing.slice();
}

/** Clear all module state (tests only). */
export function resetForTests(): void {
  consecutiveStallCycles = 0;
  forceOpenRing.length = 0;
}
