---
category: ci
module: "scripts/ci-test-shard.mjs, scripts/lib/run-vitest-watchdog.mjs, packages/dashboard/scripts/run-vitest-with-heap.mjs, packages/engine/src/agents/agent-logger.ts"
date: 2026-11-06
problem_type: ci_debugging
component: full-suite-shards
severity: high
applies_when:
  - "A Full Suite shard lane exits non-zero within seconds with a diagnostic payload of {stage: test-command, exitCode: 1, signal: null, timedOut: false} and no test output"
  - "A timing JSON reports success:true but the lane still failed"
  - "A GitHub Actions step log loses its final seconds around a failure"
  - "Debugging which lane actually failed from a shard diagnostic artifact"
tags:
  - ci
  - github-actions
  - vitest
  - shard-runner
  - diagnostics
  - unhandled-rejections
---

# The dashboard lanes did not die instantly — three defects that faked a red lane (KB-022)

## Symptom

The first Full Suite run on this fork looked like this: every `@fusion/dashboard` `test:quality:app:backfill-N` lane on both shards "started and exited 1 within ~2 seconds" — no vitest output, no timing JSON, a diagnostic payload of `{stage: "test-command", exitCode: 1, signal: null, timedOut: false}`, and a step log whose final ~2 seconds GitHub dropped. Both shards ended right after their engine invocation completed green, so the dashboard lane was the obvious suspect.

That picture was wrong in every particular. Forensic attribution across all four early runs (run ids 42188377004, 42189105239 attempts 1–2, 42202925441, 42207770829) showed **the dashboard lanes usually never ran at all** — the engine lane had already exited non-zero, the shard runner's sequential loop stopped, and the anonymous payload was inherited from whichever lane failed first.

## The three defects that produced the false picture

1. **A vitest timing JSON with `success: true` does not mean the lane exited 0.** Unhandled rejections make vitest exit 1 *after* a fully green test run, and the JSON reporter still writes `success: true`. Run 1 shard 1's intact log showed the complete signature: `Test Files 567 passed | 1 skipped (568)` → `Errors 4 errors` → `JSON report written` → exit status 1. Anyone (including the original investigation) reading only the timing artifact concludes the lane passed.
2. **The shard diagnostic payload carries no lane identity.** `{stage: "test-command", exitCode: 1, signal: null, timedOut: false}` is byte-identical whether the engine lane, a plugin lane, or a dashboard lane failed. Nothing in the payload names the command, and (pre-KB-022) it carried no captured output either.
3. **GitHub log ingestion can lose the final seconds of a step log.** The engine lane's own exit-1 lines (unhandled-rejection stack traces) were exactly in the lost tail of run 2 attempt 1, which is why the rerun with `ACTIONS_STEP_DEBUG=true` was dispatched — and why the fix could not rely on the hosted log alone.

## The real root causes, fixed in KB-022

### 1. AgentLogger fired unhandled rejections out of a partial store mock (primary)

`AgentLogger.writeEntry` fire-and-forgets `void this.flushPendingEntries()`. Its **non-batch** branch called `this.store.appendAgentLog(...)` unguarded — a partial store mock without the method threw `TypeError: this.store.appendAgentLog is not a function` *synchronously inside the `entries.map()` argument construction*, which escapes every `.catch()` and even the awaited `agentLogger.flush()` in the reviewer path. The batch branch already guarded `appendAgentLogBatch` with a `typeof` check; the single-entry path now mirrors that containment (capability check plus per-entry synchronous-throw isolation), so a best-effort log sink can never turn a green test run into an exit 1. Regression-pinned in `packages/engine/src/__tests__/agent-logger.test.ts`.

Engine-wide rule this enforces: telemetry must never become a lifecycle dependency (see the `emitBoundedRunAudit` ratchets in AGENTS.md — same principle at the logger seam).

### 2. Dashboard FN-7505 settings guard: unsurfaced key without an allowlist reason

`planReviewCapacityWakeAgeMinutes` (added by KB-009) had no description mapping and no `NOT_SURFACED_ALLOWLIST` entry, so the guard test `settings-default-descriptions.test.tsx` failed with `expected [ 'planReviewCapacityWakeAgeMinutes' ] to deeply equal []`. The key is genuinely not surfaced in Settings UI, so it belongs in the allowlist next to sibling scheduler constants. Fixed with a reasoned allowlist entry.

### 3. Engine drift tests — already fixed at HEAD, verified green

`mcp-builtin-lane-coverage` and `merge-orphan-durable-write-inventory-drift` were red on the early runs and green at the KB-022 base (landed by bff4de6f9). No KB-022 action; recorded here because the evidence matrix must account for every red lane.

## Hardening landed alongside (the structural fix + the loud-failure guard)

- **Heap wrapper de-nesting** (`packages/dashboard/scripts/run-vitest-with-heap.mjs`): the default spawn target is now a direct Node invocation of the dashboard-local vitest entry (`process.execPath` + resolved `node_modules/vitest/vitest.mjs` path) instead of a nested `pnpm exec vitest`. This removes the only spawn hop unique to the dashboard lanes; heap `NODE_OPTIONS`, the 900s wrapper watchdog, and the `FUSION_RUN_VITEST_SPAWN_OVERRIDE` test seam are preserved and tested. The exported `resolveSpawnCommand` is unit-tested; the script keeps identical behavior when executed directly.
- **Loud-failure guard** (the acceptance-3 regression guard): `runWithWatchdog` gained **opt-in** output capture (`captureTail: true`, default stays `inherit` with no capture, so `scripts/test-changed.mjs` and every existing caller are untouched). When enabled it pipes the child's streams, forwards every chunk live (passing runs stay byte-identical in the step log), retains only the last ~4 KB per stream, and on failure (non-zero code, signal, or timeout) `ci-test-shard.mjs`'s `runWatched` prints a loud banner — `LANE FAILED FAST — captured output tail follows` plus the exact command args and the bounded tails — and attaches `stderrTail`/`stdoutTail` into `error.shardDiagnostic`, which flows into the shard diagnostic payload (`fusionShardDiagnostic` in `.timings/timings-shardN-diagnostic.json`) and onward into the post-merge evidence manifest. The collector tolerates payloads with and without tails. Tails are bounded and never include the environment — the tail is the diagnostic, the environment is not.

## Node-24 axis: cleared, and how it was cleared without Docker

The operator-suspected Node-24 axis was disproven with checksum-verified probes (official Node 24 binary tarball validated against upstream `SHASUMS256.txt` — Docker was not available to the session): nested `pnpm exec vitest`, the full heap wrapper, and the exact lane chain with full CI env parity (`CI=true`, `GITHUB_ACTIONS=true`, `FUSION_TEST_TOTAL_WORKERS=4`, `FUSION_TEST_CONCURRENCY=2`) all ran past the point of the alleged instant death. CI's Node 24 satisfies the repo's `engines >= 22.19.0`; the local Node 22.14.0 is the engine-warning side, with `engine-strict` off. The dashboard lane demonstrably runs on CI from a fresh runner checkout (run 4 shard 2: 4.5 min, 177 files) — fresh-checkout survival was never the problem.

## How to debug a fast-failing CI lane now

1. Download the shard's `test-timings-shard-N` artifact and open `timings-shardN-diagnostic.json`. It now names the failure stage, and since KB-022 carries `stderrTail`/`stdoutTail` — read the tail; it usually *is* the error.
2. Cross-check the step log for the `[ci-test-shard] LANE FAILED FAST` banner: it prints the exact command args and the same tails, so a lost log tail no longer hides the cause.
3. If the timing JSONs say `success: true` but a lane failed, look for `Errors N errors` in the step log *before* the JSON-report line — unhandled rejections fail the process after a green test summary. Fix the unhandled rejection (usually a fire-and-forget write without an observer), never the reporter.
4. Reproduce locally with env parity (`CI=true GITHUB_ACTIONS=true FUSION_TEST_TOTAL_WORKERS=4 FUSION_TEST_CONCURRENCY=2`) using `pnpm test:ci:shard --shard N --total 4`, or the single lane from `buildShardCommands`.

## Hosted green-run proof

Full Suite run [`42249225690`](https://github.com/siimliimand/Fusion/actions/runs/42249225690) (workflow_dispatch on branch `fusion/kb-022`, head `92f4d8e57`) concluded **success with all 11 jobs green**: Test shards 1/4–4/4, Engine slow tier, Pipeline smoke tier, Lifecycle-column ratchet drift, Line-count audit, Dashboard curated-gate guard, Warm gate build cache, and the Post-merge Full Suite evidence gate. Every lane's timing JSON across all four shard artifacts carries `success: true` (52 lane files verified), including all four dashboard backfill lanes — the diagnostic-only symptom state is gone. `scripts/test-timings.json` was refreshed from that run's artifacts (36 packages, capturedAt `2026-11-06T16:38:25.116Z`, `--check-timings-staleness` exit 0, dry-run shard weights 695.4/695.4/695.5/695.4 s).

Two earlier hosted runs were required to get here, and both taught the invariant this doc exists for. Run [`42242393040`](https://github.com/siimliimand/Fusion/actions/runs/42242393040) (head `643d93e1f`) concluded failure 9/11 green with exactly two causes, both diagnosable from the step log in minutes instead of days: (1) shard 2's engine `auto-recovery-branch-worktree.test.ts` — an environment-conditional fixture that trusted ambient `refs/remotes/origin/HEAD`; actions/checkout of a branch ref points it at the dispatched branch, so the handler resolved `fusion/kb-022` where the fixture asserted `main` (push-to-main checkouts had masked this). Fixed at the shared fixture factory with an explicit `integrationBranch: "main"` setting — FN-183's settings-first precedence wins before any git read, proven with a scratch-repo probe reproducing both the CI mechanism and the fix. (2) shard 3's first-sighting loaded-lane flake (`PlanningModeModal.planning-flow.test.tsx` loading-poll retry), recorded as register entry 25 with the register validator synchronized — same lane ran the file green twice earlier that day and the file was unchanged since 2026-10-17, so the observation is not diff-correlated.
