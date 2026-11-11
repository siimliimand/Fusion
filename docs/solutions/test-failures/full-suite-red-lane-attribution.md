---
title: Full Suite red-lane attribution ladder
category: test-failure
module: github-actions
problem_type: ci-evidence
---

# Full Suite red-lane attribution ladder

<!--
FNXC:CiEvidenceAttribution 2026-11-11-14:28:
A red post-merge Full Suite lane must be attributed — environmental or real — before any disposition is recorded, and attribution must start with the cross-run differential rather than trial-and-error elimination. This document encodes the ladder proven during KB-018's evidence collection (runs 42188377004 and 42189105239, the KB-022-window inversion on run 42271750266, and KB-006's landing-diff arithmetic): differential attribution first, unauthenticated API substitutes second, elimination last. It is the deep-dive companion to the Red-lane attribution ladder subsection in docs/testing.md ("Required post-landing Full Suite evidence"); the no-substitution boundary in the FN-9517/FN-9437 disposition (fn-9517-fn-9437-post-merge-evidence-disposition.md) and the suite-only-flakes register protocol (suite-only-flakes-observed-register.md) constrain every verdict this ladder produces. The KB-019 rebuild disposition (kb-019-orphan-durable-write-inventory-rebuild-disposition.md) is the worked consistency example.
-->

## When to reach for this ladder

A Full Suite lane goes red after a landing. The gate contract in [docs/testing.md → Required post-landing Full Suite evidence](../../testing.md#required-post-landing-full-suite-evidence) requires an evidence-backed disposition for every non-success; this ladder is how you produce the attribution that disposition needs. Work down the ladder in order — each rung either decides the question or generates the inputs for the next. Elimination (rerunning locally, bisecting) is the last rung, not the first: the hosted record already contains the decision input most of the time, and every rung below the first works without a GitHub token.

The ladder answers exactly one question: **is this red lane environmental for this window, or is it real and owned by this landing?** It never upgrades a red lane to green. A verdict of "environmental" still requires the standard disposition record; a verdict of "real" routes the failing identities to their owner.

## Rung 1 — Cross-run differential (first move)

Compare the failing lane across two Full Suite runs at different head SHAs. Two patterns decide, and both were proven on real runs.

### The flip case: the lane is red at SHA A and green at SHA B

Measure the tree delta between A and B (`git diff --stat A B` locally, or the compare API remotely). If the delta contains no code that could touch the failing surface — docs-only, CI-config-only, or otherwise outside the lane's subject area — then B's green pass proves A's red was **environmental for that lane and window**: the code that B removed could not have repaired A's failure, so the repair agent was the environment (runner state, timing, resource pressure), not the tree.

Worked example (live-verified 2026-11-11 via the runs and jobs endpoints): in KB-022's own window, the dashboard-touching Full Suite lanes died instantly while engine lanes passed. Run `42271750266` (push on main at `77c2623694a7e52d974bf022aa77ccb7c1346e1b`, the KB-031 landing, run number 9, started `2026-11-06T18:33:15Z`) shows Dashboard curated-gate guard, Test shard 1/4, Test shard 3/4, and Test shard 4/4 all green, with the sole red being Test shard 2/4 (job `128077786065`, failing at its `Test (deterministic shard)` step with three real failing engine identities owned by KB-036). The tree delta between the KB-022-window SHAs and `77c2623694a7` contained no dashboard repair, so the earlier instant-death class is proven environmental for those lanes and that window — and, with equal force, the new shard-2 red belongs to its real owner, not to the landing under verification. State the honest scope every time: **a flip exonerates only the observed lane in the observed window** — it says nothing about other lanes, other windows, or the flip's own cause.

### The consistency case: the identical failure signature is retained across runs at different SHAs

Download or read the failing lane's retained report for both runs and compare the exact failing identities — assertion names, not merely "still red". If the signature is byte-identical across a tree delta that cannot touch the signature's file set, the failure predates both runs and is attributable to its recorded mechanism, not to either landing.

Worked example (from the committed [KB-019 rebuild disposition](./kb-019-orphan-durable-write-inventory-rebuild-disposition.md)): Full Suite run [`42188377004`](https://github.com/siimliimand/Fusion/actions/runs/42188377004) (push on main at `eed0ab4450c00fc0600272d4f6cb963107e33f50`, run number 1, started `2026-11-06T08:32:12Z`) and run [`42189105239`](https://github.com/siimliimand/Fusion/actions/runs/42189105239) (push on main at `852487d0bc9c48d1f5e5debe84b3eb2b52cf2e1a`, run number 2, started `2026-11-06T08:38:13Z`, re-ran) each retained a `test-timings-shard-2` archive reporting **exactly the same two failed assertions** in `packages/engine/.timings/timings-shard2-1.json`: `FN-8923 orphan durable-write inventory drift guard > rebuilds a current manifest without changing it`, and the separately dispositioned fusion-memory MCP lane ledger census failure. The tree delta between the two head SHAs is one docs file (`docs/fusion-stability-fix-plan-2026-11-04.md`, +47/−10 — verified by local `git diff --stat` and the compare API), which cannot touch the inventory guard or the MCP lane ledger. The signature's mechanism was already known and recorded: lineHint-only structural drift in `packages/engine/src/self-healing.ts` whose +68 enters exactly with KB-005 commit `d625586b`. Neither landing caused the red; both inherited it.

## Rung 2 — Diff arithmetic: the landing diff vs the failure signature's file set

Independently of any second run, compare the **landing diff's touched-file set** with the **failure signature's file set** (`git show --stat <landing-sha>` gives the former; the retained timing report gives the latter). If the sets are disjoint, and the diff class cannot plausibly perturb the failing surface (additive-only, docs-only, type-only declarations), the landing is arithmetically exonerated **when you can also name the signature's real mechanism** — disjointness alone is suspicion, not exoneration.

Worked example: KB-006's landing diff `ee7c9ae271e740d56d18cbf4883b68ab61e49b6e` is 5 files, 80 insertions, 0 deletions — entirely additive: `docs/architecture.md` +1, `docs/run-audit.md` +2, `packages/engine/src/__tests__/self-healing-orphaned-work-items.test.ts` +56 (an additive symptom test), `packages/engine/src/run-audit/run-audit-catalogue.ts` +9 and `packages/engine/src/util/run-audit.ts` +12 (type-only event declarations). The failing signature's file set at that window (engine `self-healing.ts` lineHint drift plus dashboard provider seeding) is disjoint from all five files, and the mechanisms are unrelated: the +68 lineHint drift enters with KB-005 `d625586b`, measured in the [KB-019 disposition](./kb-019-orphan-durable-write-inventory-rebuild-disposition.md). KB-006's landing did not cause the red shards; the run-level reds were inherited pre-existing failures, which is exactly what its delivery record dispositioned.

## Rung 3 — Unauthenticated substitutes when no token is available

Everything above the artifact payloads is readable anonymously. GitHub's REST API accepts unauthenticated requests at **60 requests/hour per IP** — enough for a full attribution pass if each call is deliberate. Use `python3` (`urllib.request`) or node `fetch` with an `Accept: application/vnd.github+json` header and a `User-Agent`; the `gh` CLI is not needed for any of this.

### Per-step job conclusions — which STEP died

`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` returns per-job `steps[]` with `name` and `conclusion` (reference: <https://docs.github.com/en/rest/actions/workflow-jobs>). This is the fastest discriminator between an instant-death lane and real test failures. Real test failures fail at the `Test (deterministic shard)` step with every setup/build step green — live-verified on run `42188377004`'s failed shard-2 job `127794063970`, where steps 1–8 (job setup, containers, checkout, Node/pnpm setup, dist hash, cache, build) all succeeded, step 9 `Test (deterministic shard)` failed, and step 10 (timing upload) still ran. An instant-death class shows the opposite: death in an early setup/build step with the test step never run. The same payload carries the canonical lane display names (Pipeline smoke tier, Test shard 1/4–4/4, Dashboard curated-gate guard, Lifecycle-column ratchet drift, Line-count audit, Engine slow tier, Warm gate build cache, Post-merge Full Suite evidence gate), so a lane's identity never has to be guessed from a job number. `GET /repos/{owner}/{repo}/actions/jobs/{job_id}` returns one job with the same `steps[]` plus `run_attempt` and `check_run_url` (the bridge to annotations).

### Check-run annotations — the failure notice, not the failing tests

`GET /repos/{owner}/{repo}/check-runs/{job_id}/annotations` returns the job-level annotations (reference: <https://docs.github.com/en/rest/checks/annotations>). Live profile for this repo (verified 2026-11-11 on jobs `127794063970` and `127831082883`, HTTP 200 unauthenticated): exactly three annotations — a `warning` (Node.js 20 deprecation notice for `pnpm/action-setup@v4`), a `failure` whose entire message is `Process completed with exit code 1.`, and a `notice` (ubuntu-latest migration). Each carries `path`, `blob_href`, `start_line`/`end_line`, `annotation_level`, `title`, `message`, and `raw_details`. This repo's vitest configs configure no `github-actions` reporter, so annotations carry **no per-test identities** — the failing assertion names live only in the retained timing artifacts. Read annotations to confirm a job's terminal state and capture the failure notice; never expect test names from them.

### Artifact metadata — names and expiry are metadata-grade evidence

`GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` lists each artifact's name, id, size, `created_at`, `expires_at`, and `expired` flag unauthenticated (reference: <https://docs.github.com/en/rest/actions/artifacts>). This is enough to prove **which** artifacts a run retained (run `42188377004` retains all four `test-timings-shard-N` plus `post-merge-full-suite-evidence` and `pipeline-smoke-report`, all unexpired, including `test-timings-shard-2` id `13489123900`) — metadata-grade evidence. It is not payload-grade: the ZIP download is token-gated for unauthenticated callers. The recorded trap (KB-018/KB-021 history): the download endpoint responds 302 to a signed blob URL, forwarding clients that send `Authorization` get 401 from the redirect target — an unauthenticated caller cannot download payloads at all. Cite artifact metadata as proof of retention; the report contents (the failing assertion names) require either a token or the already-downloaded inspection recorded in a disposition. Missing artifact ≠ evidence it existed — see the [FN-9517/FN-9437 no-substitution boundary](./fn-9517-fn-9437-post-merge-evidence-disposition.md).

### Tree-delta classification from the compare API

The remote equivalent of `git diff --stat` is `GET /repos/{owner}/{repo}/compare/{base}...{head}` (canonical reference: <https://docs.github.com/en/rest/commits/commits> — "Compare two commits"), returning `ahead_by`/`behind_by`, the commit list, and per-file `filename`/`status`/`additions`/`deletions`. Live-verified for the consistency example: base `eed0ab4450c0` → head `852487d0bc9` reports ahead_by 1 with exactly one file, matching local git byte-for-byte. Use whichever side of the repo boundary you are on; both must agree because they measure the same objects.

### Runs index — state discipline

`GET /repos/{owner}/{repo}/actions/runs?branch=main&status=completed` (or unfiltered) enumerates runs with `id`, `run_number`, `event`, `head_sha`, `status`, and `conclusion`. Run-state discipline: a run with `status: in_progress` and null `conclusion` is **not evidence** — wait for a terminal status before attributing anything to it. Filter by `branch=main` to keep the post-merge population, and prefer `status=completed` so in-flight runs never enter a differential.

### Budget and honest yield on 403

At 60 requests/hour per IP, budget before you probe: one runs-index read, one jobs read per compared run, one annotations read per failed job, one artifacts read per run, one compare — a full pass is well under ten calls. On HTTP 403, record the `X-RateLimit-Reset` timestamp, stop probing, and mark any endpoint you did not reach as "unverified-live; recorded from history" with its source in the disposition. Never retry-spam a rate-limited endpoint; a fabricated content profile is worse than an honest yield.

### A recipe that works without a token

```bash
# Which runs exist on main, and what did they conclude?
python3 - <<'PY'
import json, urllib.request
H = {"Accept": "application/vnd.github+json", "User-Agent": "ci-evidence-attribution"}
def get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=30))
runs = get("https://api.github.com/repos/{owner}/{repo}/actions/runs?branch=main&status=completed&per_page=50")
for r in runs["workflow_runs"]:
    print(r["id"], r["run_number"], r["head_sha"][:10], r["event"], r["conclusion"], r["created_at"])
jobs = get("https://api.github.com/repos/{owner}/{repo}/actions/runs/<run_id>/jobs?per_page=100")
for j in jobs["jobs"]:
    failed = [s["name"] for s in j.get("steps", []) if s["conclusion"] == "failure"]
    print(j["id"], j["name"], j["conclusion"], "failed-steps:", failed)
PY
```

## Rung 4 — Elimination fallback (last resort)

When the hosted record cannot decide — a lane red in only one run with no second run at a comparable SHA, and a diff that does touch the failing surface — eliminate. Rerun the single lane locally first (`pnpm test:ci:shard --shard 2 --total 4` reproduces a shard lane); a clean local rerun under a faithful reproduction of the CI shape suggests environment, a red local rerun localizes the failure. Then bisect SHAs if ownership is still ambiguous. Two boundaries hold: local verification is never a substitute for hosted evidence (the gate contract requires the verified GitHub-hosted record regardless of what a local rerun shows), and elimination consumes hours that rungs 1–3 consume in minutes — which is why they come first.

## Boundaries and anti-patterns

- **A flip exonerates only the observed lane in the observed window.** It is evidence about that lane's class at that time, not a license to disposition other lanes or later windows as environmental.
- **Signature equality means the same assertions, not "still red".** Compare exact failing-identity lists from retained reports; "the lane is red in both runs" alone proves nothing — different failures in one lane can share a conclusion.
- **Measure the tree delta; never assume it from commit messages.** `git diff --stat base head` or the compare API are the measurement; a subject line saying "docs:" is not.
- **No conclusion from absence.** A missing report or annotation never becomes evidence that a failure did or did not exist; absence is recorded as absence (the FN-9517/FN-9437 rule: missing artifacts, diagnostic manifests, and later reruns never substitute for or upgrade the historical attempt).
- **Cancelled and failed producers are never converted to success**, and no rerun adds evidence to or mutates a historical attempt — the disposition records the non-success and its attribution, nothing more.
- **`in_progress` with a null `conclusion` is not evidence.** Terminal status first, attribution second.
- **Annotations are step-level in this repo.** Without the `github-actions` vitest reporter they carry no test identities; the failing assertion names come from the retained timing artifacts.
- **Artifact metadata is not artifact payload.** Names and expiry prove retention; contents require download. Say which grade of evidence a claim rests on.
- **Environmental verdicts still route.** A flip-consistency or arithmetic exoneration of a red lane connects to the [suite-only flakes observed register](./suite-only-flakes-observed-register.md) protocol: a first sighting of a suite-only flake is recorded in the register with reproduction data (quarantine is reserved for a second sighting or an insufficient-coverage file), while a failure with a real owner routes to that owner as a defect. An environmental verdict never dismisses a failing identity silently.
