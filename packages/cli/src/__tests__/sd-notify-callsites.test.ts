import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * FNXC:SdNotifyWatchdog 2026-11-05-22:35:
 * Structural reachability pins for the sd_notify watchdog wiring (KB-003 /
 * FIX-12b). Under a Type=notify unit a dropped listening-path notify means the
 * start job never sees READY and systemd kills the unit in a start-timeout
 * loop, while an over-wired surface (desktop, pre-boot holding server) would
 * send READY before its real server binds — the same wedged start-up. These
 * pins live beside the behavior tests so a removed or added wiring site cannot
 * happen silently.
 */
const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("sd_notify call sites", () => {
  it("wires READY + watchdog into every real-server listening path", () => {
    for (const file of [
      join(srcDir, "commands", "dashboard.ts"),
      join(srcDir, "commands", "serve.ts"),
      join(srcDir, "commands", "daemon.ts"),
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must import the sd-notify helper`).toContain(
        'from "../sd-notify.js"',
      );
      expect(source, `${file} must send READY after its server is listening`).toContain(
        "sdNotifyReady(",
      );
      expect(source, `${file} must arm the watchdog heartbeat`).toContain(
        "startSdWatchdog(",
      );
    }
  });

  it("keeps non-supervised surfaces unwired", () => {
    // desktop.ts runs under Electron (no NOTIFY_SOCKET, separate listen call
    // site); migration-holding-server.ts binds BEFORE the real server and must
    // never send READY (a Type=notify start job blocks until READY, so a
    // holding-page send would wed start-up).
    for (const file of [
      join(srcDir, "commands", "desktop.ts"),
      join(srcDir, "commands", "migration-holding-server.ts"),
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not import the sd-notify helper`).not.toContain(
        "sd-notify.js",
      );
      expect(source, `${file} must not send READY`).not.toContain("sdNotifyReady(");
      expect(source, `${file} must not arm the watchdog`).not.toContain(
        "startSdWatchdog(",
      );
    }
  });

  it("keeps the notify helper on async exec only", () => {
    // Parity with the repo's no-blocking-shellout rules: user-facing boot code
    // must never block the event loop on a synchronous child process, and the
    // notify client is a short-lived execFile child (no detached spawn).
    const source = readFileSync(join(srcDir, "sd-notify.ts"), "utf8");
    expect(source).not.toContain("execSync(");
    expect(source).not.toContain("spawn(");
    expect(source).toContain("execFile(");
  });
});
