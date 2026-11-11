// FNXC:TestInfrastructure 2026-11-11-22:28:
// Targeting probe for scripts/run-script-tests.mjs forwarded-args coverage. Deliberately NOT named
// *.test.mjs and placed under fixtures/ so the default sweep glob (scripts/__tests__/*.test.mjs,
// which does not cross directories) and node --test directory discovery can never pick it up; it
// runs only when a caller forwards its explicit path through the runner.
import { test } from "node:test";
import assert from "node:assert/strict";

test("run-script-tests targeting probe", () => {
  assert.ok(
    !process.env.RUN_SCRIPT_TESTS_PROBE_FAIL,
    "RUN_SCRIPT_TESTS_PROBE_FAIL=1 is set: this probe is failing on purpose for run-script-tests failure-propagation coverage (expected only while the runner's child exit-code contract is under test)",
  );
});
