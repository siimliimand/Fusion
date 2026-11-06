import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFusionUnitOverride,
  buildOperatorCommands,
  OVERRIDE_INSTALL_PATH,
} from "../lib/fusion-unit-override.mjs";

// KB-010 (FIX-13): the drop-in builder is the single source of truth for the
// operator's host change. These assertions pin the deployment fences:
// deliberate heap budget, SOFT throttle only (never MemoryMax), reversibility.

test("drop-in sets the deliberate heap budget NODE_OPTIONS=--max-old-space-size=4096", () => {
  const content = buildFusionUnitOverride();
  assert.match(content, /Environment=NODE_OPTIONS=--max-old-space-size=4096/);
});

test("drop-in sets the soft MemoryHigh=12G throttle", () => {
  const content = buildFusionUnitOverride();
  assert.match(content, /MemoryHigh=12G/);
});

test("drop-in NEVER contains MemoryMax (durable-write fence: postgres shares the cgroup)", () => {
  const content = buildFusionUnitOverride();
  assert.ok(!content.includes("MemoryMax"), "MemoryMax is forbidden by FIX-13");
});

test("operator commands may mention MemoryMax only as the prohibition, never as an action", () => {
  const commands = buildOperatorCommands();
  for (const line of commands.split("\n")) {
    if (!line.includes("MemoryMax")) continue;
    assert.match(line, /NEVER MemoryMax/, "every MemoryMax mention must be the prohibition itself");
    assert.ok(!line.includes("sudo"), "no privileged command line may write MemoryMax");
  }
});

test("drop-in targets the [Service] section and is a bare drop-in fragment", () => {
  const content = buildFusionUnitOverride();
  assert.match(content, /\[Service\]/);
  assert.ok(!content.includes("[Unit]"), "override.conf must only override [Service]");
  assert.ok(!content.includes("Restart="), "Restart=on-failure belongs to the main unit and must not be overridden");
});

test("drop-in carries the KB-010 managed-by and revert note", () => {
  const content = buildFusionUnitOverride();
  assert.match(content, /KB-010/);
  assert.match(content, /Delete this file/);
  assert.match(content, /daemon-reload/);
  assert.match(content, /to revert/);
});

test("drop-in installs at fusion.service.d/override.conf (composes with KB-003 main-unit changes)", () => {
  assert.equal(OVERRIDE_INSTALL_PATH, "/etc/systemd/system/fusion.service.d/override.conf");
});

test("operator commands cover backup, install, daemon-reload, restart, verify, rollback", () => {
  const commands = buildOperatorCommands();
  assert.match(commands, /cp -a \/etc\/systemd\/system\/fusion\.service .*\.bak-/);
  assert.match(commands, /mkdir -p \/etc\/systemd\/system\/fusion\.service\.d/);
  assert.match(commands, /systemctl daemon-reload/);
  assert.match(commands, /systemctl restart fusion\.service/);
  assert.match(commands, /systemctl show fusion\.service -p MemoryHigh/);
  assert.match(commands, /NODE_OPTIONS/);
  assert.match(commands, /api\/health/);
  // Rollback is the exact inverse: remove the drop-in, reload, restart.
  assert.match(commands, /rm \/etc\/systemd\/system\/fusion\.service\.d\/override\.conf/);
});

test("operator commands require the heap budget be confirmed against a captured heapsnapshot", () => {
  const commands = buildOperatorCommands();
  assert.match(commands, /heapsnapshot/);
  assert.match(commands, /4096/);
});

test("operator commands state the Restart=on-failure dependency for the stall self-exit", () => {
  const commands = buildOperatorCommands();
  assert.match(commands, /Restart=on-failure/);
});
