---
title: KB-036 orphan durable-write inventory rebuild disposition
category: test-failure
module: "@fusion/engine"
problem_type: ci-evidence
---

# KB-036 orphan durable-write inventory rebuild disposition

<!--
FNXC:MergeReliability 2026-11-06-20:19:
This is regeneration round 2 for the FN-8923 inventory fixture (round 1 was KB-019's landed
808891760), and the repair spanned three lineage passes because the base moved under the task
twice: the Fusion engine replayed this task's commits onto a refreshed base that included
KB-016 between the failing run's SHA and the first regeneration commit (round B), and the
squash-merge landing base then included post-fork KB-046 (round C).

FNXC:MergeReliability 2026-11-11-21:56:
All three rounds are lineHint/closure structural drift only: no new durable write, no
pending:classify sentinel, and no writer-surface, classification, source, or closure-boundary
change surfaced at any point, so the reviewer-owned classification lane never fired. The two
self-healing entries KB-019 reviewed were pinned at 13148/14286 by round A, moved to
13316/14454 by KB-016's replayed +168 lines (round B), and moved again to 13330/14468 by
KB-046's post-fork net +14 lines (round C, verified at the landing base a9af45f7). Each round
refreshed only that derivable lineHint field while preserving the reviewed out-of-frontier
verdicts by call-site id. Round B's byte-identical fixed-point evidence (recorded below) was
measured at the round-B branch base cf1bb55a7 and does NOT describe the merged tree; the
round-C section records the landing-base re-verification that supersedes it.
-->

## Immutable hosted failure

Full Suite run [`42271750266`](https://github.com/siimliimand/Fusion/actions/runs/42271750266), run number `9`, `push` event on `main` at `77c2623694a7e52d974bf022aa77ccb7c1346e1b`, created `2026-11-06T18:33:15Z`, completed with `failure` at `2026-11-06T19:08:15Z` (display title "KB-031: flush post-Stop settle before plan-review finder…"). Its [Test shard 2/4 job `128077786065`](https://github.com/siimliimand/Fusion/actions/runs/42271750266/job/128077786065) failed and was the run's ONLY failing job — shards 1/3/4, the Engine slow tier, Line-count audit, Pipeline smoke tier, Warm gate build cache, Dashboard curated-gate guard, and Lifecycle-column ratchet drift all succeeded, and the post-merge Full Suite evidence gate (job `128095447526`, run-scoped re-run) also succeeded.

The retained `test-timings-shard-2` artifact `13532487625` (348,346 bytes, downloaded `sha256:a2ceb8e9fa2acd0bb237435757c64c03ddda520e4fa019f0ddb664efb66ba185`) was downloaded and inspected during this task: `packages/engine/.timings/timings-shard2-1.json` reports `testResultCount: 569` and EXACTLY three failed assertions:

1. `FN-8923 orphan durable-write inventory drift guard > rebuilds a current manifest without changing it`
2. `FN-8923 orphan durable-write inventory drift guard > pins derived writer surface and closure`
3. `fusion-memory MCP lane ledger > fusion-memory MCP lane ledger > maps every resolver call across all roots to one required bucket` — dispositioned separately in [KB-036's census section of fn-9475](fn-9475-full-suite-shard-disposition.md#kb-036-census-ledger-repair-2026-11-06).

Every other report in every retained shard has an empty `failedFullNames`, so the whole run's red set is exactly this task's scope. The run also retained `post-merge-full-suite-evidence` artifact `13533158748` (1,438 bytes, downloaded `sha256:12c0fef7dfb21fd5dc25fe2590be1817ac3df163727d3b91dc7a111a38bba4f9`), `test-timings-shard-1` `13531229263` (441,856 bytes), `test-timings-shard-3` `13531922697` (641,422 bytes), `test-timings-shard-4` `13533871068` (700,418 bytes), and `pipeline-smoke-report` `13532500431` (1,534 bytes).

Run, job, and artifact metadata (ids, names, sizes, sha256 digests) and the shard-2 report contents above were retrieved and verified first-hand via authenticated GitHub API during this task; nothing about the hosted evidence is inferred. The local focused repro at the run SHA reproduced the hosted failure deterministically: `Test Files 2 failed; Tests 3 failed | 9 passed (12)`, with the writer-surface/closure assertion failing on "reachable module is not pinned in scannedModules: expected [ …(342) ] to deeply equal [ …(341) ]" — byte-matching the hosted report's message.

## Root cause and repair

The drift source is KB-010 commit `35f61410a` (the 2026-11-06 memory-wedge fix, an ancestor of the failing run's head SHA): measured with `git show 35f61410a --numstat`, it inserted exactly +6 lines each into `packages/engine/src/triage.ts`, `packages/engine/src/runtimes/in-process-runtime.ts`, and `packages/engine/src/scheduler.ts`, and added the new 73-line module `packages/engine/src/util/runtime-stall-tracker.ts`. That single landing explains all three hosted failures:

- the new module enters the merge-reachability closure, so `scannedModules` grew 341 → 342 and the writer-surface/closure pin assertion failed for the first time (KB-019's evidence runs 42188377004/42189105239 had shown that assertion passing with lineHint-only drift);
- the six-line shifts moved four durable-write call sites by one line each and the triage MCP resolver call by six lines (811→812, 894→895, 725→726, 738→739 in the inventory; 3633→3639 in the census ledger).

This task is regeneration round 2: KB-019's landed commit `808891760` was round 1, and its two repaired `self-healing.ts` entries were stable at the round-A base (they do not appear in round A's diff). The repair then landed as two rounds because the lineage moved under the task:

1. **Round A — KB-010 drift (commit `ae2c4e253`).** `FUSION_UPDATE_MERGE_INVENTORY=1` regenerated the derivable structure: four lineHint bumps and exactly one added `scannedModules` entry (`packages/engine/src/util/runtime-stall-tracker.ts`). The fixture diff is 5 insertions / 4 deletions. KB-019's two `self-healing.ts` entries stayed at their landed 13148/14286 in this round, as the task's spec required at its planning base `77c262369`.
2. **Round B — KB-016 replay shift (commit `e57adc9c7`).** The Fusion engine replayed this task's delivered commits onto a refreshed base that included KB-016 (`cf1bb55a7`, "exempt capacity-starved in-review stalls from deadlock disposal…", +169/−1 to `packages/engine/src/self-healing.ts`, committer-dated after round A). The replay shifted both KB-019-reviewed `finalizeProvenAutoMergeTask` call sites by +168 lines (13148 → 13316 and 14286 → 14454), re-breaking only the unchanged-rebuild assertion. An exhaustive field-by-field probe (one-off vitest probe comparing `buildInventoryManifest(manifest)` against the checked-in fixture, deleted after use) proved the delta was EXACTLY those two `lineHint` fields — 447 entries on both sides, no top-level field diff, no new or removed entries, no fingerprint/verdict/classification/evidence/proof/followUp change. Round B refreshed only those two derivable lineHints; the fixture diff is 2 insertions / 2 deletions, and at the round-B branch base `cf1bb55a7` the second regeneration run left the fixture byte-identical — that byte-identity describes the branch lineage only, not the merged tree (see round C).
3. **Round C — KB-046 landing-base shift (merge-time re-derivation, 2026-11-11).** The squash-merge landing base is `a9af45f7`, which contains post-fork KB-046 commit `7918c2016` ("capacity-suppress failed-pre-merge-step merge blocker on saturated boards"): `git show 7918c2016 --numstat` measures +21/−7 (net +14) to `packages/engine/src/self-healing.ts`, with hunks at approximately 10704 (+2), 10930 (+1), and 11281 (+11) — all above both `finalizeProvenAutoMergeTask` call sites. At `a9af45f7` the calls verifiably sit at 13330 and 14468 (`grep -n 'await finalizeProvenAutoMergeTask({' packages/engine/src/self-healing.ts`), so the checked-in round-B pins 13316/14454 were stale by exactly +14 and the unchanged-rebuild assertion would have failed deterministically on the merged tree — the exact red-lane shape this task repairs. The branch's own replay protocol (the lineage note in [KB-036's census section of fn-9475](fn-9475-full-suite-shard-disposition.md#kb-036-census-ledger-repair-2026-11-06)) requires checking whether a refreshed base shifts the pins; the census section checked `triage.ts` (correctly unaffected — KB-046 does not touch it) but the round-B pass missed the `self-healing.ts` cross-check against KB-046. Round C refreshed only the same two derivable lineHints (13316 → 13330 and 14454 → 14468); every other fixture field was re-verified unchanged at the landing tip, and the regeneration fixed point was re-proven there (see Local verification).

### Exact delta

| Round | Call-site id / field | Old | New |
| --- | --- | ---: | ---: |
| A (KB-010 `35f61410a`) | `packages/engine/src/runtimes/in-process-runtime.ts::releaseFileScopeWaitingContinuations>transitioned::store.transitionWorkflowWorkItem::#1` lineHint | 811 | 812 |
| A | `packages/engine/src/runtimes/in-process-runtime.ts::runCapacityWakePass>transitioned::store.transitionWorkflowWorkItem::#1` lineHint | 894 | 895 |
| A | `packages/engine/src/scheduler.ts::invalidateMismatchedFileScopeLeaseRelease::store.updateTaskAtomic::#1` lineHint | 725 | 726 |
| A | `packages/engine/src/scheduler.ts::revalidateFileScopeLeaseReleases>revalidated::store.updateTaskAtomic::#1` lineHint | 738 | 739 |
| A | `scannedModules` closure size | 341 | 342 (adds `packages/engine/src/util/runtime-stall-tracker.ts`) |
| B (KB-016 `cf1bb55a7`, replayed) | `packages/engine/src/self-healing.ts::recoverApprovedStrandedAiMergeCommit>finalized::finalizeProvenAutoMergeTask::#1` lineHint | 14286 | 14454 |
| B | `packages/engine/src/self-healing.ts::recoverMergedReviewTasks>finalization::finalizeProvenAutoMergeTask::#1` lineHint | 13148 | 13316 |
| C (KB-046 `7918c2016`, landing base `a9af45f7`) | `packages/engine/src/self-healing.ts::recoverApprovedStrandedAiMergeCommit>finalized::finalizeProvenAutoMergeTask::#1` lineHint | 14454 | 14468 |
| C | `packages/engine/src/self-healing.ts::recoverMergedReviewTasks>finalization::finalizeProvenAutoMergeTask::#1` lineHint | 13316 | 13330 |

Round B's rows in full: `recoverApprovedStrandedAiMergeCommit>finalized` 14286 → 14454 and `recoverMergedReviewTasks>finalization` 13148 → 13316. Round C's rows in full: the same two entries 14454 → 14468 and 13316 → 13330. The rounds' line shifts are independent: KB-010's +6 insertions sit above the in-process-runtime/scheduler/triage call sites, while KB-016's +168 and KB-046's +14 net insertions sit above both self-healing call sites (their spacing, 14286 − 13148 = 1138, is preserved through 14454 − 13316 = 1138 and 14468 − 13330 = 1138).

Unchanged through all three rounds: 447 entries; no `callSiteId`, `callSiteFingerprint`, writer, ordinal, frontier boundary, axis/classification, evidence, `observedInSuite`, `executionProof`, or `followUpTaskId` change; no new durable write and no `pending:classify` sentinel; `writerSurface`, `writerSurfaceClassification`, `writerSurfaceSource`, and `closureBoundary` untouched; `inventoryStatus` remains `final`. The manifest totals reconciled into `docs/solutions/reliability/merge-orphan-body-durable-write-fences.md` are 447 derived call sites across the 342-module closure: 364 `out-of-frontier` and 83 frontier rows (70 `already-fenced`, 8 `benign-unfenced`, 5 `unresolved`) — the new module contributes no durable-write call sites, so the entry and frontier-split totals are identical to KB-019's.

### Why no classification lane fired

The task's planning-time escalation contingency ("classify genuinely new writers via the documented lifecycle axes") was armed against the possibility that the drift class had expanded into classification-bearing territory at execution time. It never did, in any of the three rounds: the guard's own regeneration contract preserved every human verdict by call-site id, produced zero `pending:classify` values, and left `inventoryStatus` `final` — the fail-closed guard itself certifies that no reviewer-owned decision was outstanding. Round B's and round C's extra drifted rows are the same two entries KB-019 regenerated in round 1 (after KB-005's +68-line landing shifted them the same way): a derivable lineHint bump on already-reviewed entries is not a lifecycle verdict, and no verdict was invented. The planning-time statement that the self-healing entries "are stable and MUST NOT appear in the fixture diff" was authored against base `77c262369` and is superseded by the KB-016 replay; the task's own mission directs regeneration "against whatever it finds there".

## Local verification

Round-B verification (branch lineage, base `cf1bb55a7` — superseded at the landing base by the round-C bullets below):

- Combined focused run (env unset) at the round-B repaired tree: `pnpm --filter @fusion/engine exec vitest run src/__tests__/merge-orphan-durable-write-inventory-drift.test.ts src/__tests__/mcp-builtin-lane-coverage.test.ts --silent=passed-only --reporter=dot` — 12/12 passed (exit 0).
- Inventory guard with `FUSION_UPDATE_MERGE_INVENTORY=1` after round B: the regeneration run rewrote the fixture with exactly the two lineHint changes (the in-memory manifest predates the write, the documented regeneration shape), then the env-unset focused guard passed 8/8.
- Round-B fixed point: a second `FUSION_UPDATE_MERGE_INVENTORY=1` run passed 8/8 and left `merge-orphan-durable-write-inventory.json` byte-identical (working-tree blob hash `f950ea299…` unchanged, `git status` clean after commit). This byte-identity is true at the round-B base `cf1bb55a7` only; it does NOT describe the merged tree, because post-fork KB-046 shifted both self-healing pins after that measurement (round C below).
- Manifest invariants re-measured after round B: 447 entries, 342 `scannedModules`, `inventoryStatus: final`, zero `followUpTaskId` starting with `pending:`, axis2Final split 364/70/8/5, both self-healing entries still `out-of-frontier` with `none:out-of-frontier` proof and follow-up.

Round-C verification at the landing base `a9af45f7` (the merged tree this commit produces):

- Landing-base re-derivation: `grep -n 'await finalizeProvenAutoMergeTask({' packages/engine/src/self-healing.ts` at `a9af45f7` reports 13330 and 14468; `git show 7918c2016 --numstat` attributes the +14 shift to KB-046 (+21/−7, hunks ~10704/+2, ~10930/+1, ~11281/+11, all above both calls). The two lineHints were bumped to 13330/14468; a `FUSION_UPDATE_MERGE_INVENTORY=1` regeneration run at the landing base then rewrote the fixture with exactly those same two lineHint changes and nothing else (2 insertions / 2 deletions vs the branch fixture, blob `23b9823e2`), proving the manual bumps equal the derivator's output.
- Fixed point at the landing base: a second `FUSION_UPDATE_MERGE_INVENTORY=1` run passed 8/8 and left the fixture byte-identical (blob `23b9823e2` unchanged, working tree clean).
- Combined focused run (env unset) at the merged tree: the same two focused files — 12/12 passed (exit 0), including the unchanged-rebuild and writer-surface/closure assertions. This is the direct symptom-gone assertion for all three hosted identities, now measured on the tree the merge lands.
- Landing-tip cross-checks of every other fixture-pinned value: triage census pin 3639 (line 3639 reads `mcpServers: (await resolveMcpServersForStore(this.store)).servers,`), in-process-runtime pins 812/895, scheduler pins 726/739, and the 342-module closure including `packages/engine/src/util/runtime-stall-tracker.ts` all still match live source at `a9af45f7` — `self-healing.ts` is the only fixture-pinned file KB-046 moved.
- The task-level fixture delta against the planning base is exactly 6 lineHint modifications plus 1 added `scannedModules` entry (round A: 5 insertions / 4 deletions; round B: 2 insertions / 2 deletions; round C: 2 insertions / 2 deletions on top of round B).

The focused guard still requires exact call-site/fingerprint bijection and final lifecycle tuples, gives missing entries `pending:classify`, and refuses unclassified `TaskStore` writers and unresolved receivers. The repair restores parity without weakening the inventory's fail-closed behavior.

## Hosted-evidence rule

This local verification is not a hosted rerun. Hosted acceptance for both repairs (inventory and census) is PENDING the first post-landing Full Suite: that run's engine shard report must show both the inventory guard and the census test absent from `failedFullNames`. Record a later hosted pass only with its run ID and URL, source SHA, shard/job identity, retained artifact ID and digest, and the exact result of the named assertions. Do not infer a hosted pass from this local result or from artifact metadata alone.
