#!/usr/bin/env node
/*
FNXC:MemoryWedge 2026-11-06-14:32:
KB-010 (FIX-13) deployment-config prep. The production engine on
factory.webuilder.dev wedged daily at the V8 old-space ceiling (~1GB budget,
2026-11-05 incident): GC thrash pinned the CPU, /api/health died, and only a
manual `systemctl restart` recovered it. This module BUILDS the reversible
systemd drop-in the OPERATOR installs — no Fusion task session ever touches
/etc/systemd/system (Infra Blast Radius standing rule).

Design fences encoded here and asserted by
scripts/__tests__/fusion-unit-override.test.mjs:

1. NODE_OPTIONS=--max-old-space-size=4096 gives the process a DELIBERATE heap
   budget sized for this 48GB host (observed working set 1.8-2.2GB RSS against
   a ~1GB default budget; cgroup peak 12.9GB shared with postgres and merge
   clean-rooms). 4096 is the operator's RECOMMENDATION, not a constant truth:
   the runbook says the final value is confirmed against the first captured
   .heapsnapshot (Step 2 evidence), never hard-coded forever. This is not a
   leak mask — the accumulator fixes (Step 4) and diagnostics (Step 2) land in
   the same task.
2. MemoryHigh=12G is a SOFT throttle: the kernel reclaims and throttles before
   the cgroup ever OOM-kills. NEVER MemoryMax — a hard kill can truncate a
   durable PostgreSQL write, and postgres shares this cgroup. The test asserts
   the literal string "MemoryMax" is ABSENT.
3. Drop-in, not main-unit edit: lands in
   /etc/systemd/system/fusion.service.d/override.conf so it composes with
   KB-003 (FIX-12b) main-unit changes (Type=notify/WatchdogSec/NotifyAccess=all)
   without conflict, and full revert is "delete the file + daemon-reload".
4. Restart=on-failure MUST remain set on the main unit: KB-010's Step 3 stall
   self-exit (exit code 1) relies on it for automatic recovery.

Usage (operator runbook lives in task KB-010 document key "deploy"):
  node scripts/lib/fusion-unit-override.mjs            # print drop-in + commands
*/

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The exact drop-in content for /etc/systemd/system/fusion.service.d/override.conf.
 * Kept as a single assembled literal so the builder, the tests, and the runner
 * print byte-identical output.
 */
export function buildFusionUnitOverride() {
  return [
    "# KB-010 (FIX-13): deliberate heap budget + soft memory throttle.",
    "# Managed by Fusion task KB-010. Delete this file, then",
    "# `systemctl daemon-reload && systemctl restart fusion.service`, to revert.",
    "[Service]",
    "Environment=NODE_OPTIONS=--max-old-space-size=4096",
    "MemoryHigh=12G",
    "",
  ].join("\n");
}

/** The drop-in file path the operator installs (never written by Fusion sessions). */
export const OVERRIDE_INSTALL_PATH = "/etc/systemd/system/fusion.service.d/override.conf";

/** Operator commands: backup, install, verify, rollback. Printed by the runner. */
export function buildOperatorCommands() {
  return [
    "# ── Install (operator-run; each step is reversible) ─────────────────────",
    "# 1. Backup the current unit (dated, KB-010-tagged):",
    "#    sudo cp -a /etc/systemd/system/fusion.service /etc/systemd/system/fusion.service.bak-$(date -u +%Y%m%d)-KB010",
    "# 2. Install the drop-in:",
    "#    sudo mkdir -p /etc/systemd/system/fusion.service.d",
    `#    sudo tee ${OVERRIDE_INSTALL_PATH} > /dev/null <<'EOF'`,
    buildFusionUnitOverride().trimEnd(),
    "EOF",
    "# 3. Load and restart:",
    "#    sudo systemctl daemon-reload",
    "#    sudo systemctl restart fusion.service",
    "# ── Verify ──────────────────────────────────────────────────────────────",
    "#    systemctl show fusion.service -p MemoryHigh",
    "#    tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value fusion.service)/environ | grep NODE_OPTIONS",
    "#    curl -fsS http://127.0.0.1:4040/api/health",
    "# ── Rollback (full revert) ──────────────────────────────────────────────",
    `#    sudo rm ${OVERRIDE_INSTALL_PATH}`,
    "#    sudo systemctl daemon-reload",
    "#    sudo systemctl restart fusion.service",
    "# ── Compose + fence notes ───────────────────────────────────────────────",
    "#    Composes with KB-003 (FIX-12b): that task edits the MAIN unit",
    "#    (Type=notify/WatchdogSec); this is a DROP-IN, so they layer cleanly.",
    "#    Keep Restart=on-failure on the main unit: KB-010's stall self-exit",
    "#    (exit code 1) depends on it for automatic recovery. NEVER MemoryMax:",
    "#    a hard cgroup kill can truncate a durable DB write, and postgres",
    "#    shares this cgroup. Heap-budget sizing: confirm 4096 against the first",
    "#    .heapsnapshot under <root>/.fusion/diagnostics/heapsnapshots/.",
  ].join("\n");
}

// ── Runner: `node scripts/lib/fusion-unit-override.mjs` prints the drop-in and commands.
const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.stdout.write(buildFusionUnitOverride());
  process.stdout.write("\n" + buildOperatorCommands() + "\n");
}
