/**
 * FNXC:SdNotifyWatchdog 2026-11-05-22:16:
 * systemd sd_notify watchdog integration (KB-003, FIX-12b — 2026-11-05
 * factory.webuilder.dev wedge incident).
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
 * - The watchdog interval is `unref`'d so the pinger never keeps the
 *   process alive on its own.
 * - Fence: the host unit's `WatchdogSec` must stay >= 6x
 *   `SD_NOTIFY_WATCHDOG_INTERVAL_MS` (180s vs 30s) so a single slow GC or
 *   transient stall never restarts the service; only a genuine multi-minute
 *   loop stall does — which is already an outage.
 * - READY=1 must be sent strictly AFTER the HTTP server is listening, or a
 *   `Type=notify` start would time out (systemd start job waits for READY).
 */
import { execFile } from "node:child_process";

/** Watchdog heartbeat cadence (ms); host `WatchdogSec` must be >= 6x this. */
export const SD_NOTIFY_WATCHDOG_INTERVAL_MS = 30_000;

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
 * Arm the 30s WATCHDOG=1 heartbeat. Idempotent (one interval max), unref'd,
 * never throws; complete no-op when `NOTIFY_SOCKET` is absent or a send
 * error already disabled notifications.
 */
export function startSdWatchdog(): void {
  if (!isSdNotifyActive() || disabled) return;
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    sendSdNotifyState("WATCHDOG=1");
  }, SD_NOTIFY_WATCHDOG_INTERVAL_MS);
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
