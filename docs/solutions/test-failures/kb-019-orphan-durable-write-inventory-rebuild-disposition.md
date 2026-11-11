---
title: KB-019 orphan durable-write inventory rebuild disposition
category: test-failure
module: "@fusion/engine"
problem_type: ci-evidence
---

# KB-019 orphan durable-write inventory rebuild disposition

<!--
FNXC:MergeReliability 2026-11-06-11:43:
A durable-write inventory lineHint is AST-derived structural evidence, not a reviewed reachability or lifecycle verdict. The FUSION_UPDATE_MERGE_INVENTORY=1 repair refreshes only changed structural fields and preserves every human verdict by call-site id; genuinely new durable writes deliberately receive pending:classify and stay red until a reviewer classifies them, as KB-009's capacity-wake entry did here. The checked-in fixture must additionally be stored in the guard writer's canonical byte form: the writer serializes through JSON.stringify (raw UTF-8), so an escaped byte form is parsed-equal but can never be a regeneration fixed point, because every regeneration run rewrites the escapes.
-->

## Immutable hosted failure

Full Suite run [`42188377004`](https://github.com/siimliimand/Fusion/actions/runs/42188377004), run number `1`, `push` event on `main` at `eed0ab4450c00fc0600272d4f6cb963107e33f50`, started `2026-11-06T08:32:12Z`, completed with `failure` at `2026-11-06T09:05:40Z`. Its failed [Test shard 2/4 job `127794063970`](https://github.com/siimliimand/Fusion/actions/runs/42188377004/job/127794063970) ran `08:32:17Z`–`08:58:48Z`. The retained `test-timings-shard-2` artifact `13489123900` (created `2026-11-06T08:58:43Z`, 345,063 bytes, `sha256:ed81cbf7f82df95fe6928bd1e1495ea1611c612e92b92a02346ac3aaa999d7da`) was downloaded and inspected during this task: `packages/engine/.timings/timings-shard2-1.json` reports exactly two failed assertions — `FN-8923 orphan durable-write inventory drift guard > rebuilds a current manifest without changing it`, and the separately dispositioned fusion-memory MCP lane ledger census failure (`docs/solutions/test-failures/fn-9475-full-suite-shard-disposition.md` row 40). The run also retained `post-merge-full-suite-evidence` artifact `13489779991` (created `2026-11-06T09:05:36Z`, 1,491 bytes, `sha256:b8c1a655156e59ed6090d6bed52ed76bc613d99a0cd49b1345584df372b530f6`).

Full Suite run [`42189105239`](https://github.com/siimliimand/Fusion/actions/runs/42189105239), run number `2`, `push` event on `main` at `852487d0bc9c48d1f5e5debe84b3eb2b52cf2e1a`, started `2026-11-06T08:38:13Z`, completed with `failure` at `2026-11-06T10:25:12Z` (the run re-ran; artifacts from both attempts are retained). Its latest-attempt [Test shard 2/4 job `127831082883`](https://github.com/siimliimand/Fusion/actions/runs/42189105239/job/127831082883) failed. The retained latest-attempt `test-timings-shard-2` artifact `13494483509` (created `2026-11-06T10:23:57Z`, 344,667 bytes, `sha256:45ef1d31acb6ff9c4c83248e3e65fe7b5e590b8863dcbf893b6264fc3cb5c789`) contains the same two failed assertions in `packages/engine/.timings/timings-shard2-1.json`; the first attempt's `test-timings-shard-2` artifact `13488974381` (created `2026-11-06T08:57:49Z`, 344,511 bytes, `sha256:3ba1e687f25fc3b6458978045b82c362a59f198880d57f3102b54b0b15359bbb`) is also retained. The run also retained `post-merge-full-suite-evidence` artifacts `13495390866` (created `2026-11-06T10:25:08Z`, 1,408 bytes, `sha256:6996b877213de874803459365c5ac4ebfbe1308c67c18c47998fe3cf990f7a12`, latest attempt) and `13490392585` (created `2026-11-06T09:05:30Z`, 1,408 bytes, `sha256:98bd4d96a5ef369738ec9fdf8a4c68f73645fc004762f734aa4759e8eb780852`, first attempt).

Run, job, and artifact metadata (ids, names, sizes, sha256 digests) and both shard-2 report contents above were retrieved and verified first-hand via authenticated GitHub API during this task; nothing about the hosted evidence is inferred.

## Root cause and repair

The hosted failure was the planning-time symptom class: lineHint-only structural drift. The fixture pinned the two `self-healing.ts` finalization call sites at 13080/14218 while the source had moved to 13148/14286. Direct git measurement attributes the +68 to KB-005 commit `d625586b`, which inserts exactly 68 lines into `packages/engine/src/self-healing.ts` above both call sites.

Before this task could execute the mechanical repair, the premise moved twice, and the eventual repair is layered:

1. **Planning-era drift (+68, KB-005 `d625586b`).** Measured with `git show <ref>:packages/engine/src/self-healing.ts | grep -n "finalizeProvenAutoMergeTask"`: the call sites sit at 13080/14218 at the fixture-regeneration commit `fa519bd1f`, at `d625586b~1`, and at `b7e1a0f28` alike, and `git show --stat d625586b -- packages/engine/src/self-healing.ts` shows exactly 68 insertions. The original report's phrasing that the drift "predates the 2026-11-06 push batch" is not reconcilable with direct measurement — the +68 enters the lineage exactly with `d625586b`, which is part of that batch. The measured facts are recorded here with their commands rather than a competing narrative.
2. **KB-007 `1381104bf` already absorbed that drift.** Its fixture regeneration recorded 13148/14286 for both entries (446 entries, 339 modules) before this task executed, so the planning-time repair was already applied by another lane.
3. **KB-009 `73f5d603d` introduced a different drift class on top.** The closure gained two modules (`workflows/capacity-wake.ts`, and `agents/planning-execution-liveness.ts` newly reachable through a new `in-process-runtime.ts` import), one genuinely NEW durable write appeared (`in-process-runtime.ts::runCapacityWakePass>transitioned::store.transitionWorkflowWorkItem::#1`, lineHint 894, the CAS held→runnable capacity wake), and `releaseFileScopeWaitingContinuations`'s write shifted 804 → 811. On that pre-classification lineage the guard read 3 failed | 5 passed (writer-surface/closure pin, bijection, unchanged-rebuild). The helper's contract marks genuinely new rows `pending:classify`, which fails the final-lifecycle assertion by design, so no agent-legal action could turn the guard green; six execution dispatches of this task recorded the honest blocked state until a reviewer classified the entry.
4. **The reviewed classification landed as KB-009 commit `bff4de6f9`.** It classified `runCapacityWakePass` `out-of-frontier` (the wake preserves its revision fences and no call edge from a merge entry point reaches it), refreshed the structural fields (447 entries, 341 modules, lineHint 811 absorbed), and performed the unblock condition recorded in this task's handoff.
5. **This task's measured regeneration delta at `bff4de6f9` is zero structural changes.** The remaining diff was serialization normalization only, committed by this task as the writer-canonical form (below).

### Exact delta

| Generation | Call-site id | Field | Old | New |
| --- | --- | --- | ---: | ---: |
| Planning-era (hosted runs 42188377004 / 42189105239) | `packages/engine/src/self-healing.ts::recoverMergedReviewTasks>finalization::finalizeProvenAutoMergeTask::#1` | lineHint | 13080 | 13148 |
| Planning-era | `packages/engine/src/self-healing.ts::recoverApprovedStrandedAiMergeCommit>finalized::finalizeProvenAutoMergeTask::#1` | lineHint | 14218 | 14286 |
| KB-009-era, pre-classification lineage | `packages/engine/src/runtimes/in-process-runtime.ts::releaseFileScopeWaitingContinuations>transitioned::store.transitionWorkflowWorkItem::#1` | lineHint | 804 | 811 |
| KB-009-era | `packages/engine/src/runtimes/in-process-runtime.ts::runCapacityWakePass>transitioned::store.transitionWorkflowWorkItem::#1` | entry | absent | added; classified `out-of-frontier` by the reviewed KB-009 verdict in `bff4de6f9` |
| KB-009-era | `scannedModules` | closure size | 339 | 341 |
| This task (at `bff4de6f9`) | 58 `callSiteFingerprint` lines | bytes | `\uXXXX` escapes (53× `u2014`, 6× `u2192`, 1× `u00b7`) | writer-canonical raw UTF-8; parsed JSON deep-equal (`unescape(removed) == added` proven per pair) |

No call-site id, fingerprint value, writer, ordinal, frontier boundary, classification, human evidence, observedInSuite, executionProof, or followUpTaskId changed in this task's repair. No entry carries `pending:classify`; `inventoryStatus` remains `final`. The manifest totals reconciled into `docs/solutions/reliability/merge-orphan-body-durable-write-fences.md` are 447 derived call sites across the 341-module closure: 364 `out-of-frontier` and 83 frontier rows (70 `already-fenced`, 8 `benign-unfenced`, 5 `unresolved`).

### Why the serialization normalization is part of the repair

The classification lane's serializer escaped non-ASCII characters (`\u2014`, `\u2192`, `\u00b7`) inside `callSiteFingerprint` strings, while the guard's writer serializes the manifest through `JSON.stringify` and emits raw UTF-8. The two byte forms parse to identical JSON — every assertion passes against either — but `FUSION_UPDATE_MERGE_INVENTORY=1` always rewrites the fixture through the writer, so committing the escaped form would leave every regeneration run dirtying the tree while passing. Committing the writer-canonical bytes is the only state in which the regeneration idempotence check (a second regen run leaves the fixture byte-identical) can hold.

## Local verification

Before this task's repair commit, with `FUSION_UPDATE_MERGE_INVENTORY` unset, the focused guard passed 8/8 against the classification-refreshed fixture (zero structural rebuild delta), and with `FUSION_UPDATE_MERGE_INVENTORY=1` it passed 8/8 with the fixture byte-identical through the run — the only pre-commit diff was the escape normalization itself.

After the repair commit:

- Focused engine inventory guard with regeneration disabled: eight tests passed.
- Focused engine inventory guard with `FUSION_UPDATE_MERGE_INVENTORY=1`: eight tests passed.
- Fixed-point check: a second regeneration run passed 8/8 and left `merge-orphan-durable-write-inventory.json` with a clean `git status`.
- `pnpm lint`.
- `pnpm test` (affected-only): exited 0. The changed set for this task is a JSON fixture plus markdown documents, which has no vitest test-file relation, so `scripts/test-changed.mjs` resolved to its documented gate-only mode (static checks + curated engine-core + CI-shape) without a live affected-package lane; the drift guard itself is covered by the focused runs above, which run its eight assertions in both modes.
- `pnpm verify:fast`.

The focused guard still requires exact call-site/fingerprint bijection and final lifecycle tuples, gives missing entries `pending:classify`, and refuses unclassified `TaskStore` writers and unresolved receivers. The repair restores parity without weakening the inventory's fail-closed behavior.

## Hosted-evidence rule

This local verification is not a hosted rerun. Record a later hosted pass only with its run ID and URL, source SHA, shard/job identity, retained artifact ID and digest, and the exact result of the named unchanged-rebuild assertion. Do not infer a hosted pass from this local result or from artifact metadata alone.

## Follow-up (KB-047, 2026-11-11): the resolver now covers this repair shape automatically

The changed-test resolver gap this disposition recorded — a fixture-plus-markdown diff resolving to gate-only so the FN-8923 drift guard got no local affected-lane coverage — is closed. `scripts/test-changed.mjs` now maps changed non-test data files to the test files inside the same package that reference them and runs those consumers in the affected lane when the memory-envelope wide-fan-out guard fires, bounded by `MAX_MAPPED_FIXTURE_TEST_FILES = 25` (an over-cap reference set refuses the mapped expansion and keeps gate-only delegation). A later regeneration of `merge-orphan-durable-write-inventory.json` therefore runs `merge-orphan-durable-write-inventory-drift.test.ts` locally, with a mapping line in the verification output naming the consumer — no explicit focused run needed for the fixture-only repair shape. This note records resolver behavior only; it does not change the historical sections above, and gate admission for the drift guard remains the separate evidence-gated decision described in the Do-NOT fences of that task.
