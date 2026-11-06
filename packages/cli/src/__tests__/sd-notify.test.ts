import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SD_NOTIFY_WATCHDOG_INTERVAL_MS,
  __resetSdNotifyStateForTests,
  __setSdNotifyExecForTests,
  isSdNotifyActive,
  sdNotifyReady,
  startSdWatchdog,
  stopSdWatchdog,
} from "../sd-notify.js";

/*
 * FNXC:SdNotifyWatchdog 2026-11-05-22:30:
 * KB-003 behavior tests for the sd_notify watchdog helper. These are pure
 * unit tests: the exec mechanism is replaced through the injected
 * `__setSdNotifyExecForTests` seam (no module mocking, no real sockets, no
 * real child processes), timers are fake, and every scenario asserts one
 * named production contract from the helper's FNXC comment block.
 */
const FAKE_SOCKET = "/run/systemd/notify";

type ExecCall = { file: string; args: string[]; timeout: number | undefined };

let execCalls: ExecCall[] = [];
let pendingExecError: Error | null = null;

function recordExec(
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: Error | null) => void,
): void {
  execCalls.push({ file, args: [...args], timeout: options.timeout });
  const error = pendingExecError;
  pendingExecError = null;
  callback(error);
}

function watchdogSendCount(): number {
  return execCalls.filter((call) => call.args.includes("WATCHDOG=1")).length;
}

describe("sd_notify helper", () => {
  beforeEach(() => {
    __resetSdNotifyStateForTests();
    execCalls = [];
    pendingExecError = null;
    __setSdNotifyExecForTests(recordExec);
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopSdWatchdog();
    __resetSdNotifyStateForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("no-op without NOTIFY_SOCKET: dev/desktop/test boots send nothing and arm no timer", () => {
    // Default environment has NOTIFY_SOCKET unset (the sandbox and dev machines).
    expect(isSdNotifyActive()).toBe(false);
    expect(() => sdNotifyReady()).not.toThrow();
    expect(() => startSdWatchdog()).not.toThrow();
    expect(execCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sdNotifyReady sends exactly one READY=1 via systemd-notify with a bounded timeout", () => {
    vi.stubEnv("NOTIFY_SOCKET", FAKE_SOCKET);
    expect(isSdNotifyActive()).toBe(true);
    sdNotifyReady();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].file).toBe("systemd-notify");
    expect(execCalls[0].args).toEqual(["READY=1"]);
    expect(typeof execCalls[0].timeout).toBe("number");
    expect(execCalls[0].timeout).toBeLessThanOrEqual(5000);
  });

  it("watchdog heartbeats at the exact 30s cadence and never sends READY=1", () => {
    vi.stubEnv("NOTIFY_SOCKET", FAKE_SOCKET);
    startSdWatchdog();
    // First heartbeat fires only after one full interval, never immediately.
    expect(execCalls).toHaveLength(0);
    vi.advanceTimersByTime(SD_NOTIFY_WATCHDOG_INTERVAL_MS);
    expect(watchdogSendCount()).toBe(1);
    vi.advanceTimersByTime(SD_NOTIFY_WATCHDOG_INTERVAL_MS * 2); // 90s total
    expect(watchdogSendCount()).toBe(3);
    expect(execCalls.every((call) => !call.args.includes("READY=1"))).toBe(true);
  });

  it("unrefs the watchdog interval so the pinger never holds the process open", () => {
    vi.stubEnv("NOTIFY_SOCKET", FAKE_SOCKET);
    const originalSetInterval = globalThis.setInterval;
    const unrefSpy = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((handler: () => void, timeout?: number) => {
        const handle = originalSetInterval(handler, timeout) as NodeJS.Timeout;
        const originalUnref = typeof handle.unref === "function" ? handle.unref.bind(handle) : null;
        handle.unref = () => {
          unrefSpy();
          originalUnref?.();
          return handle;
        };
        return handle;
      }) as typeof setInterval);
    try {
      startSdWatchdog();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(unrefSpy).toHaveBeenCalledTimes(1);
      // Fake timers stay functional through the wrapper.
      vi.advanceTimersByTime(SD_NOTIFY_WATCHDOG_INTERVAL_MS);
      expect(watchdogSendCount()).toBe(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("startSdWatchdog is idempotent: duplicate calls arm exactly one interval", () => {
    vi.stubEnv("NOTIFY_SOCKET", FAKE_SOCKET);
    startSdWatchdog();
    startSdWatchdog();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(SD_NOTIFY_WATCHDOG_INTERVAL_MS * 3);
    expect(watchdogSendCount()).toBe(3); // one pinger, not two
  });

  it("stopSdWatchdog clears the heartbeat: no timer and no further sends", () => {
    vi.stubEnv("NOTIFY_SOCKET", FAKE_SOCKET);
    startSdWatchdog();
    stopSdWatchdog();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SD_NOTIFY_WATCHDOG_INTERVAL_MS * 4);
    expect(execCalls).toHaveLength(0);
  });

  it("a send error logs exactly one warning, disables further sends, and never throws", () => {
    vi.stubEnv("NOTIFY_SOCKET", FAKE_SOCKET);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pendingExecError = new Error("send EACCES: permission denied");
    expect(() => sdNotifyReady()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("[sd-notify]");
    expect(String(warnSpy.mock.calls[0][0])).toContain("EACCES");
    // Once disabled, arming the watchdog sends nothing ever again.
    startSdWatchdog();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SD_NOTIFY_WATCHDOG_INTERVAL_MS * 4);
    expect(execCalls).toHaveLength(1); // only the failed READY attempt
  });

  it("successful sends are silent: no per-ping logging noise", () => {
    vi.stubEnv("NOTIFY_SOCKET", FAKE_SOCKET);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    sdNotifyReady();
    startSdWatchdog();
    vi.advanceTimersByTime(SD_NOTIFY_WATCHDOG_INTERVAL_MS * 3);
    expect(watchdogSendCount()).toBe(3);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
