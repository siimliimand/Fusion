---
title: Full Suite evidence manifest shape reference
category: test-failure
module: github-actions
problem_type: ci-evidence
---

<!--
FNXC:FullSuiteEvidenceManifestShape 2026-11-11-15:27:
This reference exists because at least one evidence-recorder spec assumed a top-level
`testShards` key for lane conclusions that the manifest does not have: lane conclusions live
under `producers.testShards` and `producers.pipelineSmoke`. The run-completion-time derivation
(maximum per-job `completed_at`, because the workflow-runs payload carries no `completed_at`)
was proved out by KB-033's bundle corroboration and live-verified on 2026-11-11 against run
42271750266. Every key, field name, failure code, and stage documented here was reconciled
against `scripts/post-merge-full-suite-evidence.mjs`, `scripts/ci-test-shard.mjs`, their pinned
tests, and `.github/workflows/full-suite.yml` at main `cf1bb55a7`. Version numbers are
as-of-writing facts — read the shape-evolution section before relying on them.
-->

# Full Suite evidence manifest shape reference

## Purpose and audience

The push-to-main Full Suite workflow retains a normalized evidence manifest so later verification
can corroborate GitHub-hosted CI evidence without re-downloading or re-deriving producer state.
This document is the field contract for consumers of that manifest:

- the evidence-recorder task class (KB-017, KB-033, and KB-034 are the precedents) that maps
  retained artifact conclusions into task evidence records, and
- post-merge verification readers deciding whether a landing's Full Suite run qualifies.

Authoritative sources, in order of authority: `scripts/post-merge-full-suite-evidence.mjs` (the
collector — both shapes, all failure codes), `scripts/ci-test-shard.mjs` (the dead-shard
diagnostic writer), `scripts/__tests__/post-merge-full-suite-evidence.test.mjs` and
`scripts/__tests__/ci-test-shard.test.mjs` (the pinned contracts), and the
`post-merge-evidence-gate` job in `.github/workflows/full-suite.yml` (the wiring). When this
document and the source disagree, the source wins — re-derive from it and fix this document.

## Shape at a glance

| Subject | Fact |
| --- | --- |
| Artifact name | `post-merge-full-suite-evidence` |
| File inside the artifact | `manifest.json` (collector writes `post-merge-evidence/manifest.json`, the upload step retains it) |
| Retention | 14 days; the retention step runs `if: always()` with `if-no-files-found: error` |
| Producing job | `post-merge-evidence-gate` ("Post-merge Full Suite evidence gate"), `needs: [test-shards, test-pipeline-smoke]`, `if: ${{ always() }}` |
| Complete shape | `version: 2`, no `status` key, no `failureReasons`, no `expectedArtifacts` |
| Fail-closed shape | `version: 3`, `status: "incomplete"`, `qualification.eligible: false` |
| Exit contract | Collector exits 0 on the complete shape and 1 on the fail-closed shape; it writes the manifest BEFORE throwing `EvidenceValidationError`, so a reached collector always leaves a retained artifact |
| Failure semantics | Only absent, malformed, duplicate, or invalid producer INPUT fails the collector. A red `test-shards` lane never does: producer conclusions are recorded verbatim, and red shard lanes still qualify when their timing inputs are present and parseable. A red `test-pipeline-smoke` lane DOES: report validation requires the lane conclusion to be `success`, so a red smoke lane surfaces as `invalid-pipeline-smoke-report` (or `pipeline-report-count` if the report never uploaded) and the fail-closed shape |

Both shapes are pinned by `scripts/__tests__/post-merge-full-suite-evidence.test.mjs` (version 3 +
`status: "incomplete"` assertions, and the version 2 complete assertion asserting the absence of
`failureReasons` and `expectedArtifacts`).

## Complete shape (version 2)

Emitted when every producer input is present and valid:

```json
{
  "version": 2,
  "run": {
    "repository": "<GITHUB_REPOSITORY>",
    "runId": "<GITHUB_RUN_ID>",
    "sha": "<GITHUB_SHA>",
    "url": "<GITHUB_SERVER_URL>/<GITHUB_REPOSITORY>/actions/runs/<GITHUB_RUN_ID>"
  },
  "producers": {
    "testShards": { "conclusion": "<needs.test-shards.result>", "nonBlocking": true },
    "pipelineSmoke": { "conclusion": "<needs.test-pipeline-smoke.result>", "nonBlocking": true }
  },
  "shards": [
    {
      "artifact": "test-timings-shard-N",
      "reports": [
        {
          "path": "<path relative to the evidence root>",
          "testResultCount": 0,
          "failedFullNames": [],
          "diagnostic": { "...optional, see the diagnostic contract below..." : "" }
        }
      ]
    }
  ],
  "pipelineSmoke": {
    "report": "<path relative to the evidence root>",
    "conclusion": "<needs.test-pipeline-smoke.result>",
    "durationMs": 0,
    "durationBudgetMs": 175000,
    "invocationCount": 0
  }
}
```

Notes a consumer must not get wrong:

- `shards` always contains exactly the four required artifacts
  (`REQUIRED_SHARD_ARTIFACTS`: `test-timings-shard-1` … `test-timings-shard-4`), each with a
  `reports` array holding one entry per valid timing JSON found under that artifact (the download
  layout nests `packages/<pkg>/.timings/*.json`, which the collector walks recursively).
- A red `test-shards` lane still yields the complete shape. `conclusion` values are recorded, not judged: a
  shard whose test command died contributes a diagnostic report (empty `failedFullNames`), and the
  collector still qualifies when the timing inputs are present and parseable. The pipeline-smoke lane
  is the exception: its report validation requires the lane conclusion to be `success`, so a red
  smoke lane yields the fail-closed shape (see the code inventory). The complete shape proves the
  evidence chain is intact, not that the run was green.
- The `diagnostic` key is optional per report and absent on ordinary Vitest-produced timings.

## Fail-closed diagnostic shape (version 3)

Emitted when any producer input is absent, malformed, duplicated, or invalid — before the
collector throws:

```json
{
  "version": 3,
  "status": "incomplete",
  "run": { "repository": "...", "runId": "...", "sha": "...", "url": "..." },
  "producers": {
    "testShards": { "conclusion": "...", "nonBlocking": true },
    "pipelineSmoke": { "conclusion": "...", "nonBlocking": true }
  },
  "expectedArtifacts": [
    { "artifact": "test-timings-shard-1", "presence": "absent", "reportCount": 0 }
  ],
  "shards": [ { "artifact": "test-timings-shard-N", "reports": [ { "...valid reports only..." : "" } ] } ],
  "failureReasons": [ { "code": "<see inventory>", "producer": "<artifact or pipeline-smoke-report>", "detail": "<optional>" } ],
  "qualification": { "eligible": false }
}
```

- `expectedArtifacts` has one row per required shard artifact with `presence` one of
  `"present"` / `"absent"` / `"invalid"` and `reportCount` equal to the number of JSON files found
  (valid or not). A partially malformed artifact reports `presence: "invalid"` while its valid
  reports still appear under `shards[].reports`.
- The top-level `pipelineSmoke` detail object is included in this shape ONLY when the pipeline
  report itself validated; otherwise the key is absent entirely.
- `failureReasons[].detail` is omitted when the collector has no detail for the row.
- The retained fail-closed manifest is diagnostic evidence. `qualification.eligible: false` is
  the machine-readable "this run does not qualify" verdict; no consumer may treat it as approval.

## `failureReasons` code inventory

All nine codes, reconciled against the collector source (line numbers refer to
`scripts/post-merge-full-suite-evidence.mjs` at main `cf1bb55a7`):

| Code | Producer field | Trigger |
| --- | --- | --- |
| `duplicate-producer-artifact` | the duplicate directory name | An evidence-root directory matches `^test-timings-shard-\d+\s*\(\d+\)$` — the `name (N)` suffix GitHub adds to duplicate artifact downloads. |
| `missing-timing-json` | `test-timings-shard-N` | The artifact directory contains zero JSON files. |
| `malformed-timing-json` | `test-timings-shard-N` | A timing file fails `JSON.parse`. `detail` = file path relative to the evidence root. |
| `invalid-timing-payload` | `test-timings-shard-N` | A parsed timing file has no `testResults` array. `detail` = relative file path. |
| `malformed-assertion-result` | `test-timings-shard-N` | A `testResults` entry whose `assertionResults` is not an array. The whole report is rejected — it does not appear in `shards[].reports`. |
| `malformed-shard-diagnostic` | `test-timings-shard-N` | `fusionShardDiagnostic` present but not an object with a string `stage`. |
| `pipeline-report-count` | `pipeline-smoke-report` | The pipeline report directory contains other than exactly one JSON file. `detail` = the count as a string. |
| `invalid-pipeline-smoke-report` | `pipeline-smoke-report` | The parsed report fails validation: lane conclusion not `success`, `passed` not `true`, `durationBudgetMs` not 175000, `durationMs` not an integer in [0, 175000], records/`invocationKeys` census incomplete or mismatched against this commit's pipeline scenario manifest, or any record with a non-`pass` verdict, `expectedTerminal !== observedTerminal`, or `wedge: true`. |
| `malformed-pipeline-smoke-json` | `pipeline-smoke-report` | The pipeline report file fails `JSON.parse`. |

`EvidenceValidationError` renders these as its message (`Post-merge Full Suite evidence is
incomplete: <comma-separated codes>`), which is what the gate job logs on the exit-1 path.

## Producers: where lane conclusions live (the correction)

Lane conclusions live under `producers`, not at the top level:

- `producers.testShards.conclusion` — the `test-shards` matrix aggregate result.
- `producers.pipelineSmoke.conclusion` — the `test-pipeline-smoke` job result.

Each producer entry is `{ conclusion, nonBlocking: true }`. Both values are wired verbatim by the
gate job's normalize step from GitHub's `needs.<job-id>.result` strings
(`TEST_SHARDS_RESULT: ${{ needs.test-shards.result }}`,
`PIPELINE_SMOKE_RESULT: ${{ needs.test-pipeline-smoke.result }}`), so the observed value space is
GitHub's: `success`, `failure`, `cancelled`, `skipped`. The collector copies them through without
validation.

**Anti-pattern, stated explicitly: a top-level `testShards` key does NOT exist in any shape** —
not in version 2, not in version 3, not under any condition. Recorder specs and consumers that
read `manifest.testShards` are reading a key that was never emitted; read
`manifest.producers.testShards` instead.

Consumption recipe — map lane conclusions from producers:

```js
const testShardsConclusion = manifest.producers.testShards.conclusion;
const pipelineSmokeConclusion = manifest.producers.pipelineSmoke.conclusion;
```

## Shards: failing-test identities and dead-shard diagnostics

Failing tests are per report under the top-level `shards` array (also not top-level-keyed):

- `shards[].reports[].failedFullNames` — sorted, deduplicated full names of failed assertions.
  Built from each timing payload's `testResults[].assertionResults[]` entries where
  `status === "failed"` and `fullName` is a string; deduplicated with a `Set` and sorted. The
  identity source is the Vitest JSON reporter itself, so names are exact `suite > case` style
  strings as the reporter emitted them.
- `shards[].reports[].testResultCount` — the payload's `testResults.length`.
- `shards[].reports[].path` — file path relative to the evidence root.

Consumption recipe — read failing tests from the shards array:

```js
const failingTests = manifest.shards.flatMap((shard) =>
  shard.reports.flatMap((report) => report.failedFullNames),
);
```

### The diagnostic contract (dead-shard reports)

When a shard dies before Vitest's reporter can initialize, `scripts/ci-test-shard.mjs`
(`writeShardDiagnosticPayload`) writes a schema-compatible timing payload instead:

```json
{
  "testResults": [],
  "fusionShardDiagnostic": {
    "version": 1,
    "shard": 1,
    "total": 4,
    "stage": "preflight",
    "exitCode": 1,
    "signal": null,
    "timedOut": false
  }
}
```

- Writer field types: `shard`/`total` numbers, `stage` string, `exitCode` number or null
  (omitted inputs become `null`), `signal` string or null, `timedOut` boolean (strictly `=== true`
  when set).
- The empty `testResults` array is deliberate: it preserves the failure stage without fabricating
  a failed test assertion. Consequence: a diagnostic report's `failedFullNames` is ALWAYS empty
  (`[]`) — the diagnostic identifies the failed stage, never failing tests. Never treat a
  diagnostic-bearing report as "no failures".
- Stage values and where they come from:

| Stage | Set by | `exitCode` semantics |
| --- | --- | --- |
| `preflight` | The synchronous pre-test command runner | The command's spawn status, `1` if null. `signal`/`timedOut` are not set (reported as `null`/`false`). |
| `test-command` | The watchdogged test command runner (`runWatched`) | `124` when the watchdog timed the command out, otherwise the child's code or `1`; `signal` and `timedOut` carry the watchdog verdict. |
| `shard-setup` | The writer's top-level catch default | Whatever stage-specific detail (`exitCode`/`signal`/`timedOut`) the thrown error carried; absent fields become `null`/`false`. This is the fallback for unlabeled failures. |

- The collector validates ONLY that a present `fusionShardDiagnostic` is an object with a string
  `stage`, and passes the object through verbatim into `shards[].reports[].diagnostic`. Any other
  field is whatever the writer emitted — do not assume a fixed schema beyond `version: 1` plus
  the writer's field set above.
- A report with a `diagnostic` key can appear in BOTH shapes: its input parses and validates, so
  it does not fail the collector. In the complete shape it is how "this lane's test command died"
  is expressed alongside a qualifying evidence chain.

## Pipeline smoke: two distinct surfaces

Do not conflate these two locations:

1. Lane conclusion — `producers.pipelineSmoke.conclusion`. ALWAYS present in both shapes;
   verbatim `needs.test-pipeline-smoke.result` string; never validated.
2. Normalized detail object — top-level `pipelineSmoke`:
   `{ report, conclusion, durationMs, durationBudgetMs, invocationCount }`. Present in the
   complete shape (version 2) always, and in the fail-closed shape (version 3) only when the
   report itself validated. Because validation requires the lane conclusion to be `success`, a
   present detail object implies `conclusion === "success"` on both surfaces.
   `durationBudgetMs` is pinned at `175000`; `invocationCount` is the validated record count
   (the report must reproduce this commit's full pipeline scenario census exactly — see
   `invalid-pipeline-smoke-report` in the code inventory).

## Deriving run completion time

**Status: LIVE-VERIFIED 2026-11-11** against completed run `42271750266` ("Full Suite
(non-blocking)", run number 9) on `siimliimand/Fusion`, using three unauthenticated GitHub REST
calls. This matches the derivation KB-033's bundle corroboration proved out.

- The workflow-runs payload (`GET /repos/{owner}/{repo}/actions/runs/{run_id}`) carries
  `created_at`, `updated_at`, and `run_started_at` — and NO `completed_at` field at the top
  level. Verified on the probe run: timestamp fields present were exactly
  `created_at`/`run_started_at`/`updated_at`.
- The workflow-jobs payload (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`) carries
  per-job `started_at` and `completed_at`; on a completed run every job's `completed_at` is
  non-null.
- **Derivation: run completion time = max(job.completed_at) across the run's jobs.** Verified on
  the probe run: max `completed_at` = 2026-11-06T19:08:14Z ≥ `run_started_at`
  2026-11-06T18:33:15Z. Sanity-check the derived value against `run_started_at` this way rather
  than trusting `updated_at` (it happened to track the last job completion on the probe run, but
  it can move for other reasons and is not the derivation).
- API references: [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs) and
  [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs).

## Known shape evolution (as-of-writing)

The version constants above are as-of-writing facts pinned to main
`cf1bb55a7f31bc9042d1b9978685355945dca3f8` (verified 2026-11-11): complete = version 2,
fail-closed = version 3.

**Pending, not landed:** KB-042 plans to publish failing job/step identities from the collector
(a jobs identity block in both shapes) with version bumps — complete 2 → 3, incomplete 3 → 4. At
writing, KB-042 had not landed: the manifest described here is the live truth until it does.

Re-check instruction for future readers: before relying on version numbers, read the version
constants in `scripts/post-merge-full-suite-evidence.mjs` and the assertions in
`scripts/__tests__/post-merge-full-suite-evidence.test.mjs` (they pin the shapes), and check
KB-042's card for landing state. Everything else in this document — the producers mapping, the
shards/`failedFullNames` layout, the diagnostic contract, the pipeline-smoke dual surface — is
shape, not version-number, and changes only with collector edits.

## No-substitution boundary

This reference describes what the manifest looks like; it does not weaken the evidence boundary:

- A missing normalized manifest is not evidence that it existed. A diagnostic (version 3)
  manifest records what was absent or malformed and never invents timing JSON, test results,
  failed test names, a Pipeline smoke report, or a successful producer conclusion.
- Historical GitHub evidence is immutable: a rerun, a local reconstruction, or a later upload
  cannot add artifacts to an earlier attempt. See
  [FN-9507's Full Suite evidence disposition](./fn-9507-full-suite-evidence-disposition.md) and
  [FN-9437's immutable post-merge evidence disposition](./fn-9517-fn-9437-post-merge-evidence-disposition.md)
  for the incidents that fixed this boundary and worked examples of reading real manifests.

## References

- Collector (shape source of truth): `scripts/post-merge-full-suite-evidence.mjs`
- Collector pinned tests: `scripts/__tests__/post-merge-full-suite-evidence.test.mjs`
- Dead-shard diagnostic writer: `scripts/ci-test-shard.mjs` (`writeShardDiagnosticPayload`,
  `runWatched`, top-level catch)
- Diagnostic writer pinned tests: `scripts/__tests__/ci-test-shard.test.mjs`
- Workflow wiring: `post-merge-evidence-gate` job in `.github/workflows/full-suite.yml`
- Entry point in the testing guide: `docs/testing.md` → "### Required post-landing Full Suite
  evidence"
- No-substitution dispositions:
  [fn-9507](./fn-9507-full-suite-evidence-disposition.md),
  [fn-9517/fn-9437](./fn-9517-fn-9437-post-merge-evidence-disposition.md)
- Cross-run differential attribution technique: KB-041's
  [Full Suite red-lane attribution ladder](./full-suite-red-lane-attribution.md) (landed on main
  while this reference was being finalized — earlier drafts linked only the KB-041 task card)
- Pending shape change: KB-042 (task card — jobs identity enrichment and version bumps)
- GitHub REST field references:
  [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
  [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs)
