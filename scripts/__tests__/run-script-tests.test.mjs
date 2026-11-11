// FNXC:TestInfrastructure 2026-11-11-22:28:
// Regression coverage for scripts/run-script-tests.mjs targeted (forwarded-args) mode, added after
// KB-038's full-suite sweep was killed mid-run inside the bounded verification window: targeted
// forwarding must run exactly the forwarded file, propagate a failing child's nonzero exit, and
// fail fast on a nonexistent path with the runner-level error before any child spawns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runnerPath = resolve(repoRoot, "scripts/run-script-tests.mjs");
const probeRelativePath = "scripts/__tests__/fixtures/run-script-tests-probe.mjs";
const probeAbsolutePath = resolve(repoRoot, probeRelativePath);

function runRunner(args, extraEnv = {}) {
  // FNXC:TestInfrastructure 2026-11-11-22:28:
  // node --test injects NODE_TEST_CONTEXT into its test-file subprocesses; forwarded through
  // { ...process.env } to the grandchild runner, it flips the spawned `node --test` into
  // child-protocol mode (results over the v8 channel instead of TAP on stdout, altered exit
  // semantics). Stripping it makes the spawned runner match the documented shell invocation,
  // where no test-runner context exists.
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [runnerPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

test("targeting exclusivity: a forwarded relative path runs exactly the forwarded file", async () => {
  // Defensive strip: a stray outer env value would flip the probe into its deliberate-failure mode.
  const { code, stdout, stderr } = await runRunner([probeRelativePath], { RUN_SCRIPT_TESTS_PROBE_FAIL: "" });
  assert.equal(code, 0, `runner exited nonzero for a passing probe:\n${stderr}`);
  assert.match(stdout, /run-script-tests targeting probe/);
  // TAP summary counts exactly one test — the full sweep would run hundreds.
  assert.match(stdout, /^# tests 1$/m);
  assert.match(stdout, /^# pass 1$/m);
  assert.match(stdout, /^# fail 0$/m);
});

test("failure propagation: a failing forwarded guard exits nonzero through the runner", async () => {
  const { code, stdout } = await runRunner([probeAbsolutePath], { RUN_SCRIPT_TESTS_PROBE_FAIL: "1" });
  assert.notEqual(code, 0);
  assert.match(stdout, /^# fail 1$/m);
});

test("fail-fast bad path: a nonexistent forwarded path is diagnosed by the runner before any child spawns", async () => {
  const badRelativePath = "scripts/__tests__/nope-kb058-does-not-exist.test.mjs";
  const { code, stdout, stderr } = await runRunner([badRelativePath]);
  assert.equal(code, 1);
  assert.match(stderr, /\[run-script-tests\] forwarded path does not exist:/);
  assert.ok(
    stderr.includes(resolve(repoRoot, badRelativePath)),
    `stderr must name the resolved absolute path, got:\n${stderr}`,
  );
  assert.ok(
    !stdout.includes("Could not find") && !stderr.includes("Could not find"),
    "node --test must never run for a missing forwarded path",
  );
});
