/**
 * FNXC:SdNotifyWatchdog 2026-11-06-06:42:
 * systemd sd_notify watchdog integration (KB-003, FIX-12b — 2026-11-05
 * factory.webuilder.dev wedge incident; KB-013 adds STOPPING=1 and the
 * WatchdogSec-derived ping interval).
 *
 * Why: a blocked event loop leaves the process alive, so under `Type=simple`
 * systemd sees a healthy "running" unit forever (port accepts TCP, /api/health
 * never answers) and the outage lasts until a human restarts. With a notify
 * unit, systemd expects READY=1 after start and WATCHDOG=1 heartbeats; if the
 * loop stalls long enough that pings stop, systemd kills and restarts the
 * unit — bounding the wedge class to minutes instead of hours.
 *
 * Mechanism contract:
 * - Active ONLY when `process.env.NOTIFY_SOCKET` is set and non-empty.
 *   Dev machines, tests, Electron desktop, and containers get a complete
 *   no-op: no child process, no timer, no output, zero behavior change.
 * - `systemd-notify` (the canonical sd_notify client) is EXEC'd per send
 *   instead of writing a `node:dgram` datagram to $NOTIFY_SOCKET: Node
 *   v22.14.0 (the production interpreter) has NO AF_UNIX datagram support
 *   in `node:dgram` — sending to a unix path throws `ERR_SOCKET_BAD_PORT`
 *   (verified empirically on this host). Still zero npm dependencies.
 * - Best-effort, log-once, never-throw: the first send error is logged with
 *   one `console.warn`, sets a disabled flag, and no further sends happen
 *   until process exit (or test reset). No code path throws into the boot
 *   path; successful sends log nothing (no per-ping noise).
 * - `STOPPING=1` (KB-013) is sent at the START of each wired command's
 *   graceful shutdown (serve, daemon, dashboard main shutdown) so systemd
 *   marks the unit deactivating and distinguishes a deliberate operator
 *   stop from a watchdog kill. Sent early because the notify child must
 *   land its datagram before teardown and `process.exit`.
 * - The watchdog interval is `unref`'d so the pinger never keeps the
 *   process alive on its own.
 * - Fence (KB-013): the ping interval is DERIVED once at arm time from
 *   `$WATCHDOG_USEC` (systemd sets it to the unit's `WatchdogSec` budget
 *   in microseconds) as `floor(budget / 6 / 1000)` ms, so the host fence
 *   — unit `WatchdogSec` >= 6x the ping interval — holds by construction
 *   even if the operator changes the budget. Absent, empty, non-numeric,
 *   or zero values fall back to the fixed `SD_NOTIFY_WATCHDOG_INTERVAL_MS`
 *   (30 000 ms, matching the deployed `WatchdogSec=180` byte-for-byte).
 *   No clamping in either direction: an upward clamp would break the fence
 *   for budgets < 6 s, and a larger budget simply yields a larger, still
 *   fenced interval. The future direct-datagram transport migration
 *   runbook lives in the KB-013 task document (key="docs"), not in code.
 * - READY=1 must be sent strictly AFTER the HTTP server is listening, or a
 *   `Type=notify` start would time out (systemd start job waits for READY).
 */
import { execFile } from "node:child_process";

/**
 * Watchdog heartbeat FALLBACK cadence (ms), used when `$WATCHDOG_USEC` is
 * absent or invalid; the host `WatchdogSec` budget must stay >= 6x the
 * effective interval. Matches the deployed `WatchdogSec=180` exactly.
 */
export const SD_NOTIFY_WATCHDOG_INTERVAL_MS = 30_000;

/**
 * FNXC:SdNotifyWatchdog 2026-11-06-06:42:
 * Fence factor (KB-013): the unit's `WatchdogSec` budget must stay >= 6x the
 * ping interval so a single slow GC or transient stall never restarts the
 * service; only a genuine multi-minute loop stall does — which is already an
 * outage. The derived interval divides the budget by exactly this factor.
 */
export const SD_NOTIFY_WATCHDOG_BUDGET_DIVISOR = 6;

/**
 * FNXC:SdNotifyWatchdog 2026-11-06-06:42:
 * Derive the watchdog ping interval from `$WATCHDOG_USEC` (systemd sets it
 * to the unit's `WatchdogSec` budget in microseconds). Pure and exported for
 * tests. Returns `SD_NOTIFY_WATCHDOG_INTERVAL_MS` when the value is absent,
 * empty, non-numeric, or zero; otherwise `floor(budget / 6 / 1000)` ms so
 * the `WatchdogSec >= 6x interval` fence holds by construction. Deliberately
 * no clamping: an upward clamp would break the fence for budgets < 6 s, and
 * a larger budget yields a larger, still-fenced interval.
 */
export function resolveSdWatchdogIntervalMs(watchdogUSec?: string): number {
  const trimmed = typeof watchdogUSec === "string" ? watchdogUSec.trim() : "";
  if (!/^\d+$/.test(trimmed)) return SD_NOTIFY_WATCHDOG_INTERVAL_MS;
  const budgetUSec = Number(trimmed);
  if (budgetUSec <= 0) return SD_NOTIFY_WATCHDOG_INTERVAL_MS;
  return Math.floor(budgetUSec / (SD_NOTIFY_WATCHDOG_BUDGET_DIVISOR * 1000));
}

/** Per-send child-process timeout (ms); a stuck notify client must not hang boot. */
const SD_NOTIFY_EXEC_TIMEOUT_MS = 2_000;

/** Canonical sd_notify client binary (no npm dependency). */
const SD_NOTIFY_BINARY = "systemd-notify";

/** Injectable send seam (tests stub this; production wraps `execFile`). */
type SdNotifyExec = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: Error | null) => void,
) => void;

const defaultSdNotifyExec: SdNotifyExec = (file, args, options, callback) => {
  execFile(file, args, options, callback);
};

let sdNotifyExec: SdNotifyExec = defaultSdNotifyExec;
/** Set on the first send error: one warn, then silence for the process lifetime. */
let disabled = false;
/** Single watchdog heartbeat interval (idempotent start). */
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** True only when a notify-type service manager environment is present. */
export function isSdNotifyActive(): boolean {
  const socket = process.env.NOTIFY_SOCKET;
  return typeof socket === "string" && socket.length > 0;
}

function disableAfterFirstError(state: string, error: Error): void {
  if (disabled) return;
  disabled = true;
  console.warn(
    `[sd-notify] ${state} send failed (${error.message}); watchdog notifications disabled for the remainder of this process`,
  );
}

function sendSdNotifyState(state: string): void {
  if (!isSdNotifyActive() || disabled) return;
  try {
    sdNotifyExec(SD_NOTIFY_BINARY, [state], { timeout: SD_NOTIFY_EXEC_TIMEOUT_MS }, (error) => {
      if (error) {
        disableAfterFirstError(state, error);
      }
      // Success is silent — per-ping logging would be boot-path noise.
    });
  } catch (error) {
    // Synchronous throw guard: no send path may ever throw into the caller.
    disableAfterFirstError(state, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Tell systemd the service is up. Must be called strictly after the real
 * HTTP server is listening; duplicate calls are harmless to systemd.
 * Complete no-op when `NOTIFY_SOCKET` is absent.
 */
export function sdNotifyReady(): void {
  sendSdNotifyState("READY=1");
}

/**
 * Tell systemd the service is shutting down deliberately (KB-013). Must be
 * called at the START of a graceful shutdown so the notify child lands its
 * datagram before teardown; systemd then marks the unit deactivating and
 * distinguishes a deliberate stop from a watchdog kill. Shares the no-op
 * guard, log-once disable flag, and per-send exec with the other states.
 * Complete no-op when `NOTIFY_SOCKET` is absent.
 */
export function sdNotifyStopping(): void {
  sendSdNotifyState("STOPPING=1");
}

/**
 * Arm the WATCHDOG=1 heartbeat. Idempotent (one interval max), unref'd,
 * never throws; complete no-op when `NOTIFY_SOCKET` is absent or a send
 * error already disabled notifications. The interval is resolved ONCE at
 * arm time from `$WATCHDOG_USEC` (budget/6, floored; 30 000 ms fallback).
 */
export function startSdWatchdog(): void {
  if (!isSdNotifyActive() || disabled) return;
  if (watchdogTimer) return;
  const intervalMs = resolveSdWatchdogIntervalMs(process.env.WATCHDOG_USEC);
  watchdogTimer = setInterval(() => {
    sendSdNotifyState("WATCHDOG=1");
  }, intervalMs);
  // Never hold the process open just to ping the watchdog.
  watchdogTimer.unref?.();
}

/** Clear the heartbeat (shutdown / test tidy-up). */
export function stopSdWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/** Test seam: replace the exec mechanism (no module mocking needed). */
export function __setSdNotifyExecForTests(fn: SdNotifyExec): void {
  sdNotifyExec = fn;
}

/** Test seam: full state reset (timer, disabled flag, exec mechanism). */
export function __resetSdNotifyStateForTests(): void {
  stopSdWatchdog();
  disabled = false;
  sdNotifyExec = defaultSdNotifyExec;
}
