# Fusion Stability Fix Plan — 2026-11-04

Implementation plan for the systemic defects surfaced by the 2026-11-03/04 subcontractor-marketplace
incident chain (SUBC-007 → SUBC-013). Each fix names its incident evidence, root cause with file
anchors, change design, lifecycle fences, tests, and changeset. Scope: **all fixes are Fusion
product changes** (`packages/*`) except FIX-6b (project-side watchdog) and OPS-1 (GitHub settings).

---

## 0. Verdict summary and sequencing

| ID | Priority | Fix | Repo | Depends on |
|----|----------|-----|------|-----------|
| OPS-1 | now | Flip `ci-merge-gate-pilot` ruleset to `evaluate` | GitHub settings | — |
| FIX-1 | P0 | Worktree refresh must never orphan unlanded branch commits | engine | — |
| FIX-2 | P0 | `mergeConfirmed` reconciliation (recorded SHA not on main → un-confirm, re-open merge) | engine | FIX-1 |
| FIX-3 | P1 | Janitor sweep for orphaned active workflow work items | engine | — |
| FIX-4 | P1 | Operator retry triggers immediate gate reseed + truthful refusal reasons | dashboard | FIX-3 (messages) |
| FIX-5 | P1 | External-block resume column mismatch → restart-stage | dashboard/engine | — |
| FIX-6 | P1 | Ruleset-aware PR landing fallback (merger) + watchdog alert class | engine + project | OPS-1 decision |
| FIX-7 | P1 | Infra blast-radius containment (policy + reviewer guidance) | docs/prompts | — |
| FIX-8 | P2 | Mission-interview parser: auto-wrap bare question/milestone payloads | dashboard | — |
| FIX-9 | P2 | `pi-claude-cli` → `pi-ai` import repair + boot-smoke assertion | Fusion (cli pkg) | — |
| FIX-10 | P2 | Archive ordering: oscillation reset before soft-delete | core/scheduler | — |
| FIX-11 | P1 | Post-merge landing evidence must check the recorded landing target, not the project default | engine | — |
| FIX-12 | P1 | Suspended plan-review continuations starve behind the intake firehose (no wake-on-release, no age priority at the review boundary) | engine | — |
| FIX-13 | P0 | Recurring daily memory wedge: V8 heap exhaustion stalls the event loop until manual restart | engine/dashboard | — |
| FIX-14 | P1 | In-review stall detector counts capacity starvation as deadlock, disposing healthy completed-review cards | core/engine | KB-007 (2026-11-06) |
| FIX-12a | P0 | Bound upstream JSON-stream repair (`pi-agent-core` `repairJson`) — event-loop wedge prevention | Fusion (pnpm patch) | — |
| FIX-12b | P1 | `sd_notify` watchdog: auto-restart `fusion.service` on a stalled event loop | Fusion (cli) + host unit | — |

Recommended order: OPS-1 → FIX-13 (wedged production, evidence fresh) → FIX-3 (small, unblocks designed recovery) → FIX-1 → FIX-2 → FIX-4 →
FIX-5 → FIX-14 → FIX-11 → FIX-12 → FIX-8/9/10 (independent) → FIX-6 (after the ruleset decision) → FIX-7 (anytime).
FIX-12a/12b were added 2026-11-05 after the dashboard event-loop wedge outage (board tasks
KB-001/KB-003) and are independent of the SUBC chain — file/execute them immediately.

All engine/dashboard/core fixes land via worktrees (`wt switch --create fix/...`), one commit per
step, `Fusion-Task-Id` trailers when filed as board tasks, and a changeset on
`@runfusion/fusion` (`patch` for fixes, `minor` for FIX-6's new capability). Bug-class tasks carry
mandatory `## Symptom Verification` and `## Surface Enumeration` PROMPT.md sections (FN-5893).

---

## FIX-1 (P0) — Worktree refresh must never orphan unlanded branch commits

### Incident evidence

SUBC-011: the executor committed the finished implementation (`a3764a1`, 28 files, 267 tests) at
2026-11-03 19:23:59 CET. At 19:26:43 a worktree dependency-import pass committed `4e882c0`
("import dependency content from main") and the branch ref ended up at `4e882c0` — the
implementation left the branch. It survived only because the commit object was still fresh in the
odb and a mission branch ref (`mission/M-MW0Y99TK-0001-QM7G`) contained it. A `git gc` could have
destroyed the work permanently. A sibling symptom: SUBC-011's verifier worktree sat detached at
`4e882c0` while the branch pointed elsewhere.

### Root cause

`packages/engine/src/executor/worktree-create-outer.ts` (import emitter at line ~175, import
commit block at lines ~140–181). Worktree (re)acquisition rebuilds the task branch from a base
label and squash-imports dependency content as one commit. Nothing checks whether the existing
branch tip is already an ancestor of the base before rebuilding — commits on the branch that are
not in the base are silently discarded. The design assumption ("branch is empty or fully landed")
does not hold when a session committed work that has not been merged yet, which is exactly the
state between "executor done" and "AI merge landed".

### Change design

In the branch (re)build path, before any `checkout -B` / `reset --hard` / branch re-create on a
`fusion/<taskId>` branch:

1. Compute `unlanded := !git merge-base --is-ancestor <current-tip> <base-tip>`.
2. If **not** unlanded → proceed exactly as today (rebuild + import).
3. If unlanded → **skip the branch rebuild and the import**, keep the existing worktree and branch
   untouched, and surface the refusal:
   - task-log entry: `Worktree refresh skipped: branch fusion/<taskId> has N commit(s) not in <base>; nothing discarded`
   - audit `worktree:branch-refresh-refused` via `emitBoundedRunAudit`
     (`packages/engine/src/util/emit-bounded-run-audit.ts`, FN-9175 seam), metadata
     ids/counts/outcomes only: `{ taskId, branch, base, unlandedCommitCount, outcome }`.
   - the requesting workflow node still executes against the existing worktree (the import is an
     optimization, not a precondition for node work).
4. Audit the happy-path rebuild too when it discards a *previous* rescue ref (see below), so the
   new behavior is observable.

Rationale for "skip + continue" instead of "rebase onto base": rebase reintroduces conflict
resolution inside an infrastructure path; skip keeps the fix small and non-lossy. The unlanded
state is a caller bug (FIX-2 prevents its main producer); FIX-1 guarantees it can never destroy
work while that caller bug exists.

Also sweep `packages/engine` for other `reset --hard` / `checkout -B` sites targeting
`fusion/*` branches (worktree removal disposal paths already have FN-9058/FN-9233 proof gates —
this adds the acquisition-side twin).

### Fences

- Never refuse for workspace per-repo acquisition paths that have their own lease/fence machinery
  (FN-9059) — enumerate call sites and explicitly exclude them with an FNXC comment.
- User-paused and `autoMerge:false` tasks: behavior unchanged (this path is not lifecycle-moving).
- Audit emission is bounded/best-effort (FN-9175); refusal must not become a lifecycle dependency.
- FNXC comment (`FNXC:WorktreeUnlandedGuard <date -u>`) documenting the invariant.

### Surface enumeration

- Single-repo task worktree acquisition (this file).
- Verification worktree acquisition for post-merge gate nodes (same path — covered).
- Workspace per-repo acquire (FN-9059/FN-179 machinery) — explicitly excluded, comment at site.
- Rescue-patch alternative rejected: patches on disk violate the gitignored-path guard and rot.

### Tests

- New `packages/engine/src/executor/__tests__/worktree-unlanded-guard.test.ts`: temp fixture repo
  (bounded, in-test); cases:
  1. tip ancestor of base → rebuild proceeds (current behavior preserved),
  2. tip has 1 unlanded commit → rebuild skipped, tip preserved, worktree kept, audit emitted,
  3. unlanded tip + existing worktree → node execution still possible.
- Update existing worktree-create tests whose fixtures assume unconditional rebuild.

### Symptom verification

Reproduce: fixture branch with one commit not in base; run acquisition. Before: tip discarded.
After: `git rev-parse <branch>` unchanged, refusal logged. Assert both in the test (this is the
SUBC-011 regression, at the git layer).

### Verification

`pnpm --filter @fusion/engine exec vitest run src/executor/__tests__/worktree-unlanded-guard.test.ts --silent=passed-only`
then `pnpm verify:fast`. Changeset: `patch`, `category: fix`.

---

## FIX-2 (P0) — `mergeConfirmed` reconciliation: recorded SHA not on main → un-confirm and re-open the merge

### Incident evidence

SUBC-011: `mergeDetails.mergeConfirmed=true` with `commitSha=a3764a1…` — a SHA that was never an
ancestor of main. Finalization deferred indefinitely ("required post-merge evidence gate
'post-merge-verification' is not approved" every 5 min for ~20 h); the verifier honestly failed
13+ passes ("the implementation exists nowhere reachable"); no code path un-confirmed the merge.

### Root cause

`packages/engine/src/merge/recover-confirmed-merge-push.ts:32` — runs on every finalization sweep
for merge-confirmed tasks; at ~line 74 it runs `git merge-base --is-ancestor <sha> refs/heads/<branch>`
and on failure aborts the attempt (push-retry bookkeeping only). Nothing reconciles the state:
`mergeConfirmed` is treated as proof-of-landing by finalization
(`packages/core/src/merge/confirmed-merge-reconciliation.ts`) and the graph merge node is terminal.
One writer recorded confirmation without a landing; no reader can revoke it.

### Change design

Extend `recoverConfirmedMergePush`: after the is-ancestor check fails (recorded SHA not on the
local target branch), reconcile instead of bookkeeping:

1. **Content-match self-heal**: if a commit whose *tree* equals the recorded commit's tree exists
   on the target branch (e.g. a squash landing of the same content landed under a different SHA),
   rewrite `mergeDetails.commitSha`/`landedBranchTipSha` to the main-side SHA and continue the
   normal push-recovery flow. (This also formalizes the manual repair performed on SUBC-011.)
2. **True phantom** (content nowhere on main): clear the false confirmation in one
   `updateTaskAtomic` fence: `mergeDetails.mergeConfirmed=false`, `reconciliation={ clearedAt,
   reason: "recorded-sha-not-on-target", recordedSha }`, and re-open the merge by seeding a
   continuation at the merge node via `replaceActiveTaskWorkflowContinuation`
   (`sourceColumn/targetColumn = task.column` — an in-column re-entry, never a backward column
   move). Task-log: `Auto-recovery: recorded landing SHA was never on <branch>; merge re-opened`.
3. **Bounded attempts**: per-task `mergeConfirmationReconcileCount` cap (suggest 3). On exhaustion,
   park `failed` with `error = "MERGE-CONFIRMED RECONCILIATION EXHAUSTED: recorded SHA <sha> not
   on <branch> after N attempts"` (FN-8141 honest-blocked shape, metadata keeps ids/outcomes only).
4. Audit `merge:confirmed-merge-reconciled` (`emitBoundedRunAudit`): `{ taskId, recordedSha,
   outcome: "content-match" | "reopened" | "exhausted", attempt }` — never prose.

### Fences

- Never reconcile while a merge is actually active (`isMergeActiveStatus`, merge queue,
  `activeMergeTaskId`, `isTaskExecutionLive`) — the existing guards at the top of
  `resumeMissingPostMergeGate` are the template; reuse the same predicate.
- Never reconcile a SHA that IS an ancestor (that is the healthy path → push recovery unchanged).
- `autoMerge:false` cards: reconciliation (un-confirm + re-open) is allowed — it restores the
  pre-landing state; the *re-merge* then follows the card's normal human gates.
- Lifecycle containment: no column moves by the reconcile itself; the seeded continuation re-enters
  the merge node in-column (respecting the U10b rule that `replaceActiveTaskWorkflowContinuation`
  is the only sanctioned continuation writer).
- Ordering: FIX-1 must land first — re-opening the merge re-runs worktree acquisition, which
  without FIX-1's guard could re-orphan the (re-discovered) unlanded commits.

### Surface enumeration

- Direct AI-merge path (`merge:ai-landed` → mergeDetails) — covered.
- PR-based merge path (`merging-pr`, `pr_info`) — enumerate: PR merges set commitSha to the GitHub
  merge result; the same reconciliation applies; add a test for it.
- Workspace tasks use per-repo landing records, not `mergeDetails` — explicitly out of scope,
  comment at the guard (their orphan handling is FN-9056/FN-9059 territory).
- `restartTaskStage.retryLandedVerification` (dashboard) routes on `mergeDetails.mergeConfirmed` —
  after clearing, retry naturally routes to stage restart (desired; add a test).

### Tests

New `packages/engine/src/merge/__tests__/recover-confirmed-merge-reconcile.test.ts` with fixture
repos:
1. SHA is ancestor → push recovery unchanged (no reconcile).
2. SHA not ancestor, same-tree commit exists on main → commitSha rewritten, push proceeds.
3. SHA not ancestor, content absent → confirmation cleared, merge-node continuation seeded,
   in-column move only, audit emitted.
4. Exhaustion → honest-blocked park with the exact marker string.
5. Merge-active → no reconcile (guard).
Update existing `recover-confirmed-merge-push` tests that assert the silent give-up.

### Symptom verification

Reproduce the SUBC-011 shape (confirmed SHA ≠ anything on main) → before: defers forever; after:
merge re-opens and lands. Assert the task reaches `done` with a *new* landed SHA in the fixture.

### Verification

File-scoped engine vitest, then `pnpm verify:fast`. Changeset: `patch`, `category: fix`.

---

## FIX-3 (P1) — Janitor sweep for orphaned active workflow work items

### Incident evidence

SUBC-008: `merge`-kind work item `ce4056ed` (node `merge-gate`, run
`exec-SUBC-008-1793723947174-sfmc`) went `runnable` at 16:50:45.558Z — 700 ms *after* the
external-block pause-abort cleanup (16:50:44.854Z) had torn the run down. The orphan sat active for
~22 h and silently vetoed the designed post-merge-gate reseed
(`seedWorkspaceCodeReviewContinuationIfIdle` fails closed on any active item). Recovery only
resumed after an operator failed the row by SQL.

### Root cause

Work items have no lifecycle owner once their run dies.
`ACTIVE_WORKFLOW_WORK_ITEM_STATES = ["runnable","running","held"]`
(`packages/core/src/types/merge/merge-queue.ts:48`). Self-healing sweeps exist for phantom executor
bindings (FN-6736) and orphaned pending step-results (FN-8492) — not for work items.

### Change design

New self-healing sweep `reconcile-orphaned-active-work-items`, registered in both the startup
recovery step list and the periodic maintenance list (`packages/engine/src/self-healing.ts:2040`
and `:3118`), after `adopt-legacy-task-rows` (it reasons about task state):

- **Candidate**: item state ∈ ACTIVE, and the canonical liveness triple proves the owning run dead:
  no `activeSessionRegistry` surface for the task, no `executingTaskLock`, task not executing —
  plus a staleness floor (`item.updated_at` older than `max(30 min, 3× heartbeat)`) and, for
  `held`, an expired/absent lease.
- **Action**: `transitionWorkflowWorkItem(id, "failed", { lastError: "orphaned-by-dead-run" })`
  per item, transactional, one budget per sweep (mirror `MAX_STARVATION_DROPS` semantics).
- **Audit**: `task:reconcile-orphaned-work-item` — `{ taskId, workItemId, kind, priorState,
  outcome }`, ids/fixed enums only; deduped no-action variant (`-no-action`) when liveness proof
  fails (a live session exists — never touch it).
- **Explicit exclusions**: items belonging to a live merge (`activeMergeTaskId`); workspace
  lease-fenced items (FN-9059 has its own reclaim — coordinate, do not double-claim); items whose
  task is currently executing; `kind:"merge"` items while `isMergePending(taskId)` could still be
  true on another node.

This sweep is the engine-owned version of the manual repair that unblocked SUBC-008; the manual
SQL repair then becomes unnecessary.

### Tests

`packages/engine/src/__tests__/self-healing-orphaned-work-items.test.ts`: seed items —
dead-run `runnable` (transitioned), live-session `running` (untouched), expired-lease `held`
(transitioned), live-run `runnable` (untouched), budget exhaustion (one sweep, bounded). Assert
audit rows + dedupe. Use the existing self-healing fixture harness; no real polling.

### Symptom verification

Seed the exact SUBC-008 shape (dead run + active merge-kind item + merge-confirmed task + failed
post-merge gate due for recheck) → before: reseed never fires; after: item failed, gate reseeds.
Assert end-to-end within one sweep tick.

### Verification

File-scoped engine vitest + `pnpm verify:fast`. Changeset: `patch`, `category: fix`.

---

## FIX-4 (P1) — Operator retry triggers immediate gate reseed, and refusals tell the truth

### Incident evidence

SUBC-008: with the evidence finally in place, `POST /tasks/:id/retry` answered
`409 "Post-merge verification cannot be retried while pending, active, held, or already approved;
landing proof is preserved"` — none of those words described the actual blocker (an orphaned work
item from FIX-3). The same route worked instantly once the orphan was cleared (proved live at
08:18Z). The operator had no truthful signal and no path other than waiting for the hourly
backoff.

### Root cause

`packages/dashboard/src/routes/task-restart-stage.ts:104-109` — `retryLandedVerification` throws a
single hard-coded conflict for every non-`"resumed"` outcome of `resumeMissingPostMergeGate`
(`packages/engine/src/merge/post-merge-gate-reseed.ts:126`), which has ~7 distinct fail-closed
guards, none named in the response.

### Change design

1. Extend `PostMergeGateResumeResult`'s not-resumable arm with a machine reason:
   `{ outcome: "not-resumable", reason: "merge-active" | "lease-fresh" | "execution-live" |
   "finalize-blocker" | "active-work-items" | "workflow-selection-changed" | "not-due" }`
   (the seed helper's `{ seeded:false, reason:"active-continuation" | ... }` already returns most
   of these — thread them through instead of collapsing to a boolean).
2. Map reasons to precise 409 messages, e.g. `active-work-items` →
   `"Post-merge verification recheck blocked: active workflow work item <id> (<kind>, state <state>) belongs to a dead run — self-healing will fail it; retry after"`.
   Keep `landing proof is preserved` only for the genuinely approved/pending gate case.
3. No change to the automatic backoff (`isRejectedGateRecheckDue`, 15/30/60-min curve) — it is good
   design; this fix only makes the operator door honest and immediate when `manualRetry` is
   eligible.

### Tests

Dashboard route test (mocked store/engine): each refusal reason → assert 409 body names that
guard; manualRetry success path still seeds (regression for SUBC-008's live fix).

### Symptom verification

Seed a merge-confirmed task + failed gate + a dead-run active item → retry returns the
`active-work-items` message naming the item id (before: misleading generic conflict).

### Verification

`pnpm --filter @fusion/dashboard exec vitest run src/routes/__tests__/<restart-stage-test>.ts`.
Changeset: `patch`, `category: fix`.

---

## FIX-5 (P1) — External-block resume with a column-mismatched node → restart-stage, not a guaranteed interpreter error

### Incident evidence

SUBC-008: freeze at the credential boundary recorded `resume.nodeId = "parse"` (a WIP-column node).
The executor then finalized the card to `in-review` during pause. The dashboard Retry resumed the
graph at `parse` → `"Cannot move SUBC-008 to 'in-progress': Unsanctioned lifecycle move:
'in-review' → 'in-progress'"` → run failed, card parked with a dead continuation, planner logged
`"nothing is scheduled to advance it"`. Only a manual retry-again (stage restart) recovered it.

### Root cause

`packages/dashboard/src/routes/task-external-block-resume.ts` republishes the continuation at the
frozen node unconditionally. If the card advanced to a column the node does not own, the graph's
own lifecycle containment (correctly) refuses the node's column move — the run errors instead of
the resume degrading gracefully.

### Change design

At resume-publication time, compare the resolved resume node's column role with the task's current
column:

- Task column is **at or ahead of** the resume node's column → the frozen node is stale: route the
  resume through the stage-restart plan (`planTaskColumnRestart` at the current column's entry
  node) and log `External-block resume retargeted: node <X> belongs to an earlier column; restarting stage at <Y>`.
- Task column is **behind** the resume node's column (card moved backward since the freeze) → keep
  the existing resume-at-node behavior.
- Merge-active or live-execution → keep current refusal behavior.

The retarget uses the sanctioned restart-stage publication (same fence as
`restartTaskStage`), so no new lifecycle authority is introduced.

### Tests

Route test: external block with `resume.nodeId="parse"` + task now `in-review` → publication
targets the review entry node, no backward move attempted; control case: task still in WIP →
resume-at-node preserved.

### Symptom verification

Replay the SUBC-008 shape → before: interpreter error + dead continuation; after: stage restart
seeds and the card proceeds.

### Verification

File-scoped dashboard vitest. Changeset: `patch`, `category: fix`.

---

## FIX-6 (P1) — Ruleset-aware landing: PR fallback in the merger (engine) + watchdog alert class (project)

### Incident evidence

SUBC-013's `ci-merge-gate-pilot` ruleset (required `test` check, non-fast-forward, deletion on
`refs/heads/main`) made `git push origin main` fail with
`! [remote rejected] main -> main (push declined due to repository rule violations)`. This blocks:
the AI merger's landing contract (local advance + direct push), SUBC-008's watchdog (next real
landing attempt), and SUBC-013's own landing. Manually proved workaround today: push the landing
SHA to the task branch → CI runs → PR → squash-merge → sync local main → reconcile
`mergeDetails.commitSha` (PR #3, run 41797163430 green → merged as `0645df5`).

### Root cause

The landing contract has no detection or fallback for ref-level push rejection; the ruleset turns
"gate" into "outlaw" for direct pushes (GitHub evaluates required checks on the pushed commit,
which only a PR flow can pre-produce).

### Change design

**6a. Engine (this repo, `packages/engine/src/merge/` landing push step):**

1. On push failure matching rule-violation signatures (`remote rejected` + `repository rule`),
   emit audit `push:ruleset-declined` (`{ taskId, remote, branch, outcome }`) and switch to PR
   landing for that landing:
   - push the landing commit to `refs/heads/fusion/<taskId>` (task branch; ruleset only covers
     main),
   - `gh pr create --base main --head fusion/<taskId>` (gh is authenticated on the host),
   - bounded wait for the required checks (poll `gh pr checks`, cap ~15 min; on timeout park
     honest-blocked `PR CHECKS PENDING: <pr url>` with `blockedBy` empty → replan column per
     FN-8141 semantics — nothing external is wrong, it is a wait),
   - `gh pr merge --squash` preserving the commit message,
   - `git fetch` + fast-forward local main (or `reset --hard origin/main` after verifying tree
     equality — the SUBC-011 precedent) **inside the same merge-write fence**,
   - rewrite `mergeDetails.commitSha`/`landedBranchTipSha` to the actual post-merge main tip
     (the squash SHA is new; this bookkeeping belongs to the fallback, not to an operator).
2. Feature detection only: fall back on the rejection signature; never force-push; never disable
   or mutate rulesets from Fusion code.
3. Workspace lands and `merging-pr` tasks keep their existing machinery (explicit exclusion).

**6b. Project repo (`subcontractor-marketplace`, separate small PR):**
`scripts/push-main-when-ahead.mjs` — recognize the same rejection and write the alert file with
reason class `ruleset-declined` once (distinct from generic drift spam), then exit non-zero. Keep
the generic alert path for everything else. This is project code; file it as a project task, not a
Fusion one.

### Fences

- The PR fallback inherits the merge-write fence; landing is still one atomic bookkeeping unit.
- `autoMerge:false` cards: PR is created but *merging* stays human (existing PR-review contract).
- Bounded waits only (cap; fake timers in tests — no real polling loops, FN-5048).

### Tests (engine side)

Merger unit tests with mocked `git`/`gh`:
1. direct push OK → behavior unchanged (no PR),
2. ruleset-declined → PR created, checks green → squash-merged, local main synced, commitSha
   reconciled,
3. checks timeout → honest-blocked park with exact marker,
4. non-rule push failure → existing transient-retry path unchanged.

### Symptom verification

Fixture: ruleset-declining remote stub → landing lands via PR path and reaches `done` (before:
remote-rejected → transient-retry loop → stuck).

### Verification

Engine file-scoped vitest + `pnpm verify:fast`. Changeset: `minor`, `category: feature`
(summary: "Merger lands via pull request automatically when the remote requires status checks").
The 6b watchdog change is a project-repo change with that repo's own conventions — no Fusion
changeset.

---

## FIX-7 (P1) — Infra blast-radius containment for repo/host settings mutations (policy + guidance)

### Incident evidence

SUBC-013 created ruleset `ci-merge-gate-pilot` with `enforcement: "active"` on the production repo
mid-task (2026-11-04 09:01 CET), redefining the push transport for every task, the merger, and the
watchdog — while its own acceptance was still unverified. File-scope leases and symbol locks guard
files and symbols; nothing guards *repository or host settings*.

### Change design (honest about enforceability)

1. **AGENTS.md standing rule**: tasks must not create/modify GitHub rulesets, branch protection,
   webhooks, repository settings, host cron, or secrets without the task spec explicitly scoping
   it and the change being surfaced in the task log with evidence. Pilots land as
   `enforcement: "evaluate"` (dry-run) and are flipped to active only by an operator decision.
2. **Reviewer guidance** (pre-merge review prompt scaffolding): add one checklist line — "Did the
   session change repository/host configuration outside the worktree (rulesets, branch protection,
   webhooks, cron, secrets)? If yes, require evidence it is reversible and approved."
3. **Executor guidance** (system-prompt/tool-guidance text): same prohibition stated at session
   start for tasks whose spec does not explicitly request infra changes.
4. Optional later hardening (out of scope here): an audit-only detector for `gh api rulesets`
   invocations from task sessions.

This is deliberately policy + prompt work, not a hard technical fence — say so in the task spec.

### Files

`AGENTS.md`, `docs/agents.md`, executor/reviewer prompt scaffolding (check
`agent-prompts.test.ts` size budgets before adding lines).

### Verification

Prompt-budget tests stay green; docs-only otherwise. Changeset: none for AGENTS.md/docs; `internal`
changeset only if shipped prompt text changes.

---

## FIX-8 (P2) — Mission-interview parser: auto-wrap bare payloads

### Incident evidence

Four interview sessions across two models (`glm-5.3-flash`, `glm-5.3`) died at
`"Invalid response structure"`: the model returned a bare question
`{"id":"q5-pilot-timing","type":"single_select","question":"…","description":"…"}` — passes
`"type" in parsed`, fails `"data" in parsed` → reformat prompt also failed → all parse attempts
exhausted → session error. One exact `parsedSnippet` is in the journal at 2026-11-03 18:06:52 CET.

### Root cause

`parseMissionAgentResponse` (`packages/dashboard/src/mission-interview.ts`, ~line 727) requires the
`{type:"question"|"complete", data}` envelope. A bare question object is unambiguous but rejected;
the follow-up "reformat" request did not reliably repair model behavior.

### Change design

Add a normalize step *before* the envelope check:

```ts
// FNXC:InterviewEnvelopeNormalize <date -u>
// Models intermittently drop the {type, data} envelope; a bare question or
// milestone payload is unambiguous, so wrap instead of failing the session.
if (parsed && typeof parsed === "object" && !("data" in parsed)) {
  const p = parsed as Record<string, unknown>;
  const looksLikeQuestion = typeof p.id === "string" && typeof p.question === "string";
  const looksLikeMilestones = Array.isArray((p as { milestones?: unknown }).milestones);
  if (looksLikeQuestion) parsed = { type: "question", data: parsed };
  else if (looksLikeMilestones) parsed = { type: "complete", data: parsed };
}
```

Keep strict rejection for anything still ambiguous; emit a bounded diagnostic counter
(`mission:interview-envelope-repaired`, ids/counts only) so model discipline is measurable.

### Tests

Unit tests adjacent to the existing parser tests: bare question wraps; bare `{milestones:[...]}``
wraps; proper envelopes unchanged; junk rejected; the exact journal `parsedSnippet` now parses
(this is the regression assertion).

### Verification

Dashboard file-scoped vitest. Changeset: `patch`, `category: fix`.

---

## FIX-9 (P2) — `pi-claude-cli` → `pi-ai` import repair + boot-smoke assertion

### Incident evidence

`[extensions] Failed to load packages/pi-claude-cli/index.ts: Cannot find module
'…/@earendil-works/pi-ai/dist/compat.js/utils/transcript'` — every ~5 minutes in production logs
since at least yesterday.

### Root cause

`packages/pi-claude-cli/index.ts:18` imports `@earendil-works/pi-ai/utils/transcript`; the
lockfile-resolved pi-ai version routes that subpath to `dist/compat.js/utils/transcript`, which the
installed version no longer ships (upstream restructure).

### Change design

1. Inspect the installed package's `exports` map
   (`node_modules/.pnpm/@earendil-works+pi-ai@*/node_modules/@earendil-works/pi-ai/package.json`);
   point the import at the current location of the transcript helpers (or drop the import if the
   extension no longer needs it — check usage of `getCurrentSystemPrompt`/`getCurrentTools` first).
2. Pin the resolved pi-ai version deliberately (lockfile; catalog if the repo uses one) so future
   upstream drift fails a build, not a production log.
3. Strengthen `pnpm smoke:boot`: assert the boot log contains no `[extensions] Failed to load`
   lines (small, deterministic, catches this class at the gate instead of in prod logs).

### Verification

`pnpm smoke:boot` green with the new assertion; `pnpm --filter @runfusion/fusion build` green.
Changeset: `patch`, `category: fix` (dev note: extension load repair).

---

## FIX-10 (P2) — Archive ordering: oscillation reset before soft-delete

### Incident evidence

Journal 2026-11-03 17:21:16 CET:
`Failed to reset dispatch oscillation state for SUBC-007 on move to archived: Task SUBC-007 is
soft-deleted (deletedAt=2026-11-03T16:21:15.823Z) and cannot be read or mutated`.

### Root cause

`packages/engine/src/scheduler.ts:1345-1365` — on the transition to `archived`, the oscillation
reset runs after the same move has soft-deleted the row; the store refuses reads/mutations on
soft-deleted rows, so the cleanup write fails (log noise; state possibly left stale for
lineage-resurrected tasks).

### Change design

Reorder within the move flow: perform the oscillation reset **before** the soft-delete when the
transition target is a terminal archived move (the reset is part of the same transition, not a
follow-up). If the store API makes reordering awkward, the narrow alternative is a
deleted-row-tolerant internal cleanup write used only by this seam, with an FNXC comment justifying
the scope. Prefer the reorder.

### Tests

Scheduler unit test: done task with oscillation state → move to archived → no warning logged,
oscillation state cleared (assert via the store), soft-delete still applied.

### Verification

File-scoped engine vitest. Changeset: `patch`, `category: fix`.

---

## FIX-11 (P1) — Post-merge landing evidence must check the recorded landing target, not the project default

### Incident evidence

SUBC-013 (a **mission task**, `mission_id: M-MW0Y99TK-0001-QM7G`): its AI merge intentionally
landed to the mission branch — task log: `AI merge: merging fusion/subc-013 into
mission/M-MW0Y99TK-0001-QM7G`, followed by `advanced mission/M-… → 4bc5dc0d` and `landed 4bc5dc0d`.
`mergeDetails.mergeTargetBranch` was recorded as the mission branch. Yet the merge-confirmed
reachability check and the post-merge verification step both resolved the **project default
branch (main)** and demanded the content there: `Verified live that SUBC-013's work is not landed:
fb4586f is not an ancestor of main, eslint.config.mjs is absent from main` → REVISE → the same
merge-confirmed/deferred limbo as SUBC-008/SUBC-011. Closed only by an operator manually landing
the mission content to main and rewriting the bookkeeping — which should never have been required.

### Root cause

- `packages/engine/src/project-engine.ts:329-380` — the mergeConfirmed reachability check takes
  `integrationBranch` from callers that resolve it via `resolveIntegrationBranch(...)`
  (**project default** = `main`), ignoring the recorded `mergeDetails.mergeTargetBranch`. The
  docstring at :333-336 even describes the poisoned-confirmation shape it then fails to reconcile.
- The post-merge verification step's evidence context (workflow-graph executor / step prompt
  construction, see `packages/engine/src/executor/workflow-step-verdict.ts` and the
  `post-merge-verification-step` node plumbing) resolves the reference branch the same
  default-first way, so the AI verifier audits `main` regardless of where the landing went.
- Contrast — the correct pattern already exists in-tree: `recoverConfirmedMergePush` reads
  `const branch = details.mergeTargetBranch` (`recover-confirmed-merge-push.ts:~41`). FIX-2's
  reconciliation inherits that correctness; this fix aligns the remaining readers.

### Change design

1. **Target-aware reachability**: the mergeConfirmed reachability check prefers
   `mergeDetails.mergeTargetBranch` when present; `resolveIntegrationBranch` remains only the
   fallback for rows that lack it. When the recorded target differs from the project default,
   emit audit `merge:target-branch-divergence` (`{ taskId, recordedTarget, projectDefault,
   outcome }` — ids only) so target-divergent landings are visible instead of silent.
2. **Target-aware verification evidence**: pass the landing target branch (and its tip) into the
   post-merge verification step's evidence context; the task instructs the verifier to audit the
   landing on `<target>`, not on `main`. The step's completion criteria (landed SHA reachable on
   the target + first post-landing run on that target) are otherwise unchanged.
3. **Policy, documented**: mission-task landings are verified against the mission branch; arrival
   on `main` is the mission *promotion's* concern and carries its own verification (SUBC-013's
   every-push CI now covers any branch landing, so promotion runs get gated checks for free).
   Record as an FNXC comment plus a short paragraph in `docs/architecture.md` (mission lifecycle
   section).

### Fences

- No lifecycle moves introduced; all existing guards (merge-active, execution-live, leases,
  pauses, `autoMerge:false`) are untouched.
- Rows with **no** `mergeTargetBranch` (legacy shape) keep today's behavior exactly — fallback
  only, never a behavior change for existing non-mission tasks.
- Audit emission bounded (FN-9175).

### Surface enumeration

- Mission tasks (landing target = mission branch) — the fixed case.
- Non-mission tasks (target = project default) — behavior unchanged; covered by fallback test.
- PR-based merges (`merging-pr`, `pr_info`) — target recorded per landing; covered.
- Workspace per-repo landings — per-repo records, explicitly out of scope (comment at site).
- `restartTaskStage.retryLandedVerification` and `resumeMissingPostMergeGate` — they route on
  `mergeConfirmed`/evidence decision, not on branch resolution; unaffected, add regression tests
  with a mission-target fixture.

### Tests

`packages/engine/src/__tests__/post-merge-target-branch.test.ts` (fixture repo):
1. Recorded target = mission branch, SHA ancestor of that branch → reachable `true` even though
   absent from main (before: `false` — the SUBC-013 regression),
2. Recorded target absent → project-default fallback unchanged,
3. Verification evidence context carries the target branch to the step,
4. Divergence audit emitted when target ≠ project default.

### Symptom verification

Replay the SUBC-013 shape (mission-task landing to a mission branch) → before: verifier audits
main and the card defers forever; after: gate approves against the mission branch without any
operator landing.

### Verification

File-scoped engine vitest + `pnpm verify:fast`. Changeset: `patch`, `category: fix`.

---

## FIX-12a (P0) — Bound upstream JSON-stream repair (board task KB-001)

### Incident evidence

2026-11-05 ~12:24+ CET: the production dashboard (`fusion.service`, 127.0.0.1:4040) accepted TCP
but never answered `/api/health`; the worker sat at 100% CPU (state `R`, ~2.1 GB RSS, ~11 h CPU
time) and the entire dashboard+engine was unreachable until an operator restarted the unit.
Diagnosis was done live without disruption: SIGUSR1 activated the Node inspector, CDP
`Debugger.pause` captured the spinning stack:

```
repairJson ← parseJsonWithRepair ← parseStreamingJson ← (proxy.js toolcall_delta) ← processTicksAndRejections
```

The captured module was unminified tsc ESM matching `@earendil-works/pi-agent-core@1.1.0`
`dist/proxy.js` (not `pi-coding-agent`'s minified chunks).

### Root cause

`pi-agent-core`'s proxy event loop runs `content.arguments = parseStreamingJson(content.partialJson) || {}`
on **every** `toolcall_delta` — re-parsing the entire accumulated tool-argument buffer — and on
parse failure `parseJsonWithRepair` calls `repairJson`: an O(n) character loop with string
concatenation over the whole buffer. Quadratic per-delta work on a large/degenerate tool-call
argument spins the loop forever. No Fusion code is involved; this is an upstream defect hit
through Fusion's in-process agent runtime.

### Change design

`pnpm patch @earendil-works/pi-agent-core` (registered under `pnpm.patchedDependencies`): inside
`repairJson`, throw a typed `JsonRepairInputTooLargeError` (size in message) when
`json.length > 2_000_000`; behavior below the cap stays byte-identical. The stream errors and the
session fails honestly instead of wedging the process. First verify the specifier the dashboard
actually loads (dev-boot stack capture or `import.meta.resolve`); if `pi-coding-agent`'s bundled
copies are reachable in-process, patch that package too.

### Symptom verification

Unit test feeds a >cap `partialJson` with an invalid escape (the wedge shape): before, unbounded
repair work; after, immediate typed throw. Sub-cap inputs stay byte-identical; the
`toolcall_delta` path surfaces the error to the session stream instead of hanging.

### Verification

File-scoped vitest for the patched package; `pnpm verify:fast`. Changeset: `patch`, `fix`.

---

## FIX-12b (P1) — `sd_notify` watchdog auto-restart (board task KB-003)

### Incident evidence

Same outage: the wedged process never exits, so `Restart=on-failure` never fired and systemd saw
a healthy "running" unit for hours. Only the manual operator restart bounded the outage.

### Change design

1. **App side** (`packages/cli`): a dependency-free sd_notify helper used by dashboard/serve boot.
   When `NOTIFY_SOCKET` is set: send `READY=1` once the HTTP server listens, then `WATCHDOG=1`
   every 30 s from an unref'd `setInterval`; datagram writes are best-effort, log-on-error,
   never throw. Absent `NOTIFY_SOCKET` → complete no-op (dev/desktop/tests unaffected).
2. **Host side — explicitly scoped per the Infra Blast Radius standing rule**: edit
   `/etc/systemd/system/fusion.service` (that unit only): add `Type=notify` and `WatchdogSec=180`;
   keep `Restart=on-failure`, `RestartSec=5`, `TimeoutStopSec=45`. Operator-approved in the
   2026-11-05 session; dated backup copy (`fusion.service.bak-20261105-FIX12b`) and before/after
   diff go in the KB-003 task log. Sequence matters: land + build the app change first, then the
   unit edit, then `daemon-reload` + restart (an app without the pinger under `Type=notify` would
   fail startup).

### Fences

- `WatchdogSec ≥ 6× ping interval` (180 vs 30) — transient stalls/GC never restart; only a
  multi-minute loop stall (already an outage) does.
- `READY=1` strictly after listening; stop semantics unchanged.
- No other unit, timer, cron, or secret is touched.

### Symptom verification

App-side: fake-timer test asserting READY/WATCHDOG cadence and log-once error suppression.
Host-side: after the edit, `systemctl show fusion.service -p Type,WatchdogUSec` reflects the
fields and `/api/health` is 200 post-restart.

### Verification

File-scoped vitest; host verification via `systemctl show` + health check recorded in the task
log. Changeset: `minor`, `feature`.

---

## FIX-12 (P1) — Suspended plan-review continuations starve behind the intake firehose

### Incident evidence

2026-11-05, subcontractor-marketplace project (`proj_b86ec8b962644b90`): the board grew 24 → 59 tasks
overnight (the engine's own follow-up factory) while **zero cards entered development all day**.
SUBC-016 sat at the `plan-review` graph node in `runnable` for ~24 h and was re-seeded **239–240
times** (`task:reconcile-stranded-hold-continuation`, `stalenessMs: 118539810`), while tasks created
*that same evening* (SUBC-056/057/058, 18:59) were admitted to `plan` immediately. Audit window:
13 `task:workflow-run-suspended` events, all `reason: "capacity"`, all at `parse`/`plan-review`
nodes; 86 `workflowWorkItem:transition` events in 3 h (churn, not progress).

### Root cause — corrected framing (triage admission order is NOT the bug)

- Triage's planning discovery **is** age-sorted correctly: `discoverReadyPlanningTasks` returns
  `[...eligibleTriageTasks, ...eligibleTodoTasks].sort(createdAt asc)` (`packages/engine/src/
  triage.ts:2268-2278`). Do not "fix" this; it already prefers the oldest.
- The starvation happens at a **different boundary**. Under the FN-8453 shared-capacity model,
  `claimed` counts live top-level holders (in-progress tasks, `status:"planning"` triage items,
  active in-review) (`triage.ts:2469-2498`). A card whose graph is **suspended at plan-review**
  holds `status: null` / column `todo` — it counts as **zero claimed capacity**, so its resume
  must win a freed slot against the intake firehose.
- The race is structurally lost: the triage poll runs every ~15 s and re-admits the next oldest
  intake card the moment any slot frees, while the suspended plan-review continuation only
  re-attempts on the ~15-minute `reconcile-stranded-hold-continuation` cadence. With arrival rate
  ≥ drain rate, a review-waiting card can starve indefinitely — exactly what SUBC-016 did.

### Change design

1. **Wake-on-release**: when a live agent slot is released (executor/graph-run completion,
   planning-triage finish), immediately attempt resume of suspended `capacity` continuations in
   age order instead of waiting for the next 15-minute reconcile tick. The resume attempt itself
   still goes through every existing admission gate (it only changes *when* the attempt happens).
2. **Boundary age-priority**: a plan-review continuation whose suspension age exceeds a threshold
   (suggest 30 min, configurable) is admitted **before** fresh intake planning admissions when
   both compete in the same poll. Rationale: a re-seeded review is minutes from completion and
   unblocks a whole card (its downstream work), while a fresh parse starts a multi-step pipeline.
3. **Visibility**: emit the existing `task:plan-admission-throttled` (or a sibling) with
   `blockedReason: "capacity"` including the oldest suspended review continuation's
   `stalenessMs` so operators can see starvation instead of inferring it from churn counts.
4. **Documentation**: FNXC comment at the shared-cap arithmetic (`triage.ts:~2474`) recording the
   starvation model and the two fixes; note in `docs/architecture.md` capacity section.

### Fences

- No new capacity is invented: the fixes change *who wins a freed slot and when the resume is
  attempted*, never the cap arithmetic or the FN-8453 claim model.
- All existing gates apply to the resumed review as before (pauses, dependencies, leases,
  worktree room, `autoMerge:false`); the resume attempt remains best-effort and idempotent.
- The 15-minute reconcile stays as the safety net; wake-on-release is an additional trigger,
  not a replacement.

### Surface enumeration

- Suspended `plan-review` continuations (the starved case — SUBC-016 shape).
- Suspended `parse`/`plan` capacity waits (same wake path must benefit, no regression).
- Fresh intake admissions competing in the same poll (lose only to aged review continuations).
- Multiple simultaneous releases (batch wake must remain bounded, oldest-first).
- `autoMerge:false` and paused cards (never woken — existing suppression rules unchanged).

### Tests

`packages/engine/src/__tests__/plan-review-starvation.test.ts`:
1. Intake flood with cap N: a plan-review continuation suspended longer than the threshold is
   admitted ahead of fresh intake parses on the next freed slot (before: starves),
2. Wake-on-release: releasing a slot triggers the suspended-continuation resume without waiting
   for the reconcile interval,
3. Fresh intake admits when no aged continuation waits (no regression),
4. Paused / `autoMerge:false` cards are never woken by the release hook.

### Symptom verification

Replay the SUBC-016 shape (cap shared with ≥3 planning holders, one card runnable at plan-review,
continuous intake arrivals) → before: card starves >24 h with hundreds of re-seeds; after: card
resumes within one slot-release and completes plan-review.

### Verification

File-scoped engine vitest + `pnpm verify:fast`. Changeset: `patch`, `category: fix`.

---

## FIX-13 (P0) — Recurring daily memory wedge: V8 heap exhaustion stalls the event loop until manual restart

### Incident evidence

Production host `factory.webuilder.dev` (48 GB RAM, 37 GB available — **host memory is not the
problem**; this is in-process):

- 2026-11-05 21:09–21:16 CET: engine node pinned at 110–112 % CPU (`R` state), `/api/health`
  timed out at 45 s, RSS climbing 1.8 → 2.2 GB, self-healing watchdogs firing every ~2 min
  ("triage poll still marked in-flight after 130–233 s", "continuation-drain stalled 320 s"),
  zero live worker sessions. **Manual `systemctl restart` required** — healthy again in ~90 s.
- Dashboard diagnostics (30-min cadence) show the V8 heap hitting its budget at 20:10:
  `heap=1014MB/1.0GB`, recovering to `432MB/534MB` after GC — repeated near-limit operation is
  GC thrash (CPU spin), not steady-state load.
- Same death pattern the previous night: 2026-11-05 ~09:30–09:37 DB `CONNECT_TIMEOUT` storms
  from the old instance before its 10:39 restart. Restart cadence is effectively daily
  (Nov 4 12:24, Nov 5 10:39, Nov 5 21:19).
- Contributing load shape: the managed board grew 24 → 59 tasks in one day (engine-filed
  follow-ups); cgroup peak 12.9 GB (merge clean-rooms, npm installs, postgres in same cgroup).

### Root cause (to be confirmed by snapshot, design below)

The process operates repeatedly at the V8 old-space ceiling (~1 GB budget observed) under a
working set that grows with board size and session count. Suspected unbounded accumulators to
investigate: persisted `ai_sessions.conversation_history` (planning/interview transcripts),
`task_documents`/`task_log` working sets per poll, the triage poll's whole-board materialization
(`discoverReadyPlanningTasks` resolves every candidate), run-audit and listener arrays surfaced in
diagnostics, and merge clean-room transients. The 110 % spin with climbing RSS is GC thrash
against the near-full old space — the loop yields just enough for timers to fire (watchdogs log),
but no request or poll can complete.

### Change design

1. **Evidence first**: extend the existing 30-minute dashboard diagnostics loop with heap-pressure
   detection — when `heapUsed/heapTotal > 0.9` on two consecutive readings, write a
   `.heapsnapshot` to a root-only, gitignored directory (retention: keep 3, delete older) and log
   the path. Add an event-loop-lag monitor (e.g. 5 s heartbeat check); on >30 s lag, log heap
   stats immediately. This turns the next wedge into a named, inspectable artifact.
2. **Bound the accumulators**: audit and cap what grows with the board — trim/archive
   `conversation_history` for terminal sessions (retention policy), confirm run-audit retention
   covers the marketplace board's volume, and make the triage poll's candidate resolution respect
   a bounded batch (it already filters-first; verify the 59-task board's per-poll allocation).
3. **Deliberate heap budget**: set `NODE_OPTIONS=--max-old-space-size` explicitly in
   `fusion.service` (recommend 4096 for this 48 GB host) so the budget is a decision, not a
   Node default — sized AFTER the snapshot identifies the real working set, not as a leak mask.
4. **Containment without mid-write kills**: add `MemoryHigh=12G` (soft throttle) to the unit —
   NOT `MemoryMax` (a hard kill can truncate a durable DB write; postgres shares the cgroup).
5. **Self-recovery**: after N consecutive forced-guard-open stall cycles (e.g. 5) with the health
   endpoint failing, the process performs a graceful self-exit (`process.exit(1)`) and lets
   systemd restart it — formalizing the manual remedy, with startup recovery already proven to
   reclaim in-flight work (worktrees preserved, commits intact — observed 2026-11-05 on SUBC-016/021).

### Fences

- No hard `MemoryMax`/OOM-kill paths without a durable-write analysis (postgres in same cgroup).
- Heap snapshots: root-only perms, gitignored path, retention-capped; never committed.
- No lifecycle or admission-model changes; startup recovery behavior unchanged.
- The self-exit path must flush what the exit path can flush and must never fire while a durable
  write is in flight — gate it on the same liveness triple the reconciles use.

### Surface enumeration

- Dashboard diagnostics loop (heap-pressure + lag detection) — dashboard package.
- `fusion.service` unit (NODE_OPTIONS, MemoryHigh) — deployment config.
- Session persistence (conversation_history retention) — core store.
- Triage poll allocation — engine (bounded-batch verification only; FIX-12 covers ordering).
- Self-exit watchdog — engine runtime.
- All affected surfaces: planning/execute/review lanes (any lane can wedge the shared loop),
  both projects on the host, boot smoke (`pnpm smoke:boot`) after unit changes.

### Tests

`packages/dashboard/src/__tests__/heap-pressure-diagnostics.test.ts` and
`packages/engine/src/__tests__/stall-self-exit.test.ts`:
1. Consecutive over-budget readings → snapshot written, retention capped at 3,
2. Event-loop lag > threshold → immediate heap-stats log,
3. N consecutive stall cycles + failing health → self-exit invoked (mock process.exit),
4. Healthy process → no snapshots, no exit (no regression),
5. Unit-file lint: NODE_OPTIONS and MemoryHigh present (config construct assertion).

### Symptom verification

Replay the wedge: drive `heapUsed` to the budget in a fixture process → before: silent spin;
after: snapshot artifact + lag log, and after N stall cycles the process self-exits and systemd
restarts it — board recovers without operator action (assert via boot smoke + startup-recovery
fixtures).

### Verification

`pnpm verify:fast` + `pnpm smoke:boot`. Changeset: `patch`, `category: fix` (diagnostics +
runtime), deployment-config change documented in the changeset `dev` field.

---

## FIX-14 (P1) — In-review stall detector counts capacity starvation as deadlock, disposing healthy completed-review cards

### Incident evidence

2026-11-06, fusion project (`proj_67ae5a1eb06e4218`, `maxConcurrent` = 2 at the time, 10+ tasks):
KB-007's review **completed**; the merge handoff could not claim an agent slot (2/2 held).
The self-healing sweep surfaced `completed-review-status-none` ("Completed review task has no
merge owner or status for >= 5 min") three times (02:16, 02:31, 02:46) and auto-disposed the
card: `In-review stall auto-disposed … deadlock-prevention threshold reached after 3 identical
stalls — pausing task` → task `failed` with `In-review stall deadlock`. The card was healthy —
its only blocker was a saturated board. An operator retry (after the cap was raised to 6)
recovered it immediately. A sibling 02:06 stall (`merge-blocker: failed pre-merge steps`) came
from the same saturated window.

### Root cause

- The signal (`packages/core/src/tasks/in-review-stall.ts:295-320`): all steps done/skipped +
  `status == null` + no error + `mergeRetries === 0` + untouched for `staleMergingMinAgeMs`
  (5 min) → `completed-review-status-none`. The 5-minute threshold assumes a **healthy-capacity
  board** where a completed review hands off to the merge lane within minutes.
- The disposal counter (`packages/engine/src/self-healing.ts:11167-11251`): 3 identical stalls →
  `In-review stall deadlock` → pause/failed. Neither site asks **whether the card could have
  advanced at all** — under saturation the "no progress" evidence is manufactured by the cap,
  not by the card.

### Change design

1. **Capacity-exemption at the signal**: when the project is capacity-saturated
   (`claimed >= resolveMaxConcurrentSetting(settings)` — reuse the exact claim computation triage
   uses, `computeTopLevelConcurrencyClaimedFromStore`), suppress the
   `completed-review-status-none` signal (and any stall code whose condition is "card wants a
   slot and hasn't got one"). Emit a **deduped** capacity-wait log line
   (`In-review stall suppressed [capacity]: claimed=N/max`) so suppression is visible, not silent.
2. **Handoff-aware repair for this code**: with capacity available, a completed review with no
   merge owner should first get its merge handoff **re-driven** (the same restart-stage /
   merge-continuation reseed family FIX-5 uses) before any disposal. Disposal is then reserved
   for cards that fail to advance *with* free capacity — a genuine deadlock.
3. **Counter hygiene**: reset the identical-stall counter when the underlying cause changes
   (capacity freed mid-window), so stale counts can't dispose a card after recovery.
4. **FNXC** at both sites recording the starvation model: a stall is only evidence of deadlock if
   the card had room to move.

### Fences

- Genuine deadlock disposal is preserved: with free capacity, 3 identical stalls still dispose.
- No lifecycle authority changes: the sweep stays read-mostly + bounded; the handoff re-drive
  uses only sanctioned seams (restart-stage / continuation reseed, per FIX-5).
- `autoMerge:false`, user-paused, and PR-based human-review cards keep their existing suppression
  (`allowsAutoMergeProcessing` gate) — capacity suppression is additive, never overrides those.
- Suppression log is deduped and bounded (FN-9175 seam if audited).

### Surface enumeration

- `completed-review-status-none` (the KB-007 shape — capacity-starved completed review).
- `merge-blocker` stall surfaced during saturation (02:06 sibling) — same exemption check.
- Other stall codes that imply "waiting to advance" (parse/plan capacity suspends are
  work-item-level and already exempt — verify no double counting).
- Cards with `autoMerge:false` / user-paused / PR human-review contract — unchanged.
- Healthy boards — disposal behavior identical (regression tests below).

### Tests

`packages/engine/src/__tests__/in-review-stall-capacity.test.ts`:
1. Saturated capacity + completed-review card → signal suppressed, deduped capacity log, counter
   not incremented (before: disposed after 3),
2. Free capacity + same card shape → stall counts; 3 identical → disposal preserved,
3. Capacity frees mid-window → counter reset, card proceeds via handoff re-drive,
4. `autoMerge:false` card under saturation → still suppressed for capacity, never re-driven
   (human-review contract intact).

### Symptom verification

Replay the KB-007 shape (cap 2, review completes, merge lane full): before — card failed after
~15 min of stalls; after — card is held as a visible capacity-wait and completes its merge
handoff the moment a slot frees, never disposed.

### Verification

File-scoped core+engine vitest + `pnpm verify:fast`. Changeset: `patch`, `category: fix`.

---

## OPS-1 (done 2026-11-04) — `ci-merge-gate-pilot` ruleset disabled

~~Flip to `evaluate`~~ — **not possible**: the `evaluate` enforcement tier requires GitHub
Enterprise; this repo's plan returns `422 Enforcement evaluate option is not supported on this
plan`. The chosen alternative was **`enforcement: "disabled"`** (ruleset kept, not deleted),
applied 2026-11-04 10:17 CET:

```bash
gh api repos/siimliimand/subcontractor-marketplace/rulesets/26516182 > /tmp/ruleset.json
python3 -c "import json; r=json.load(open('/tmp/ruleset.json')); r['enforcement']='disabled'; json.dump(r, open('/tmp/ruleset-disabled.json','w'))"
gh api repos/siimliimand/subcontractor-marketplace/rulesets/26516182 --method PUT --input /tmp/ruleset-disabled.json
```

Empirical correction recorded in the repo's decision-log: the ruleset's required-status-check rule
declined **direct** pushes to `main` too (not only PR merges) — SUBC-013's "direct pushes stay
legal" claim was disproven live when a landing push was rejected with `push declined due to
repository rule violations`. Disabling restored the direct-push landing model (verified by landing
SUBC-013's work to main immediately after).

**Re-activation condition**: only after FIX-6 (ruleset-aware PR landing in the Fusion merger)
ships and is verified. Re-evaluation trigger otherwise: pilot end (Gate 3 / day-90 go/no-go), as
recorded by SUBC-013 in the project's `docs/decision-log.md`.

---

## Cross-cutting conventions applied to every fix

- **FNXC comments**: `FNXC:<Area> <yyyy-MM-dd-hh:mm>` with the timestamp from `date -u`; describe
  the invariant the change encodes.
- **Audit**: new emitters use `emitBoundedRunAudit` (engine) / core seam (FN-9177); metadata is
  ids/counts/fixed-outcomes only — never error prose, never SHAs-of-branches where ids suffice.
- **Lifecycle containment**: no automatic backward column moves; re-entries use sanctioned
  continuation writers; `userPaused` and `autoMerge:false` are honored everywhere.
- **Tests**: behavioral only (never assert comments/source text); fixtures over marathon runs;
  fake timers for any wait; changed-file-scoped verification runs; `pnpm test:gate` is the merge
  gate.
- **Bug-class tasks** file with `## Symptom Verification` (original symptom, exact reproduction,
  assertion it is gone) and `## Surface Enumeration` (single-repo vs workspace paths, PR vs direct
  landing, desktop/mobile n/a here) per FN-5893.
- **Changesets**: labeled format (`summary` ≤ 120 chars, `category`, optional `dev`); `fix`/patch
  for all except FIX-6 (`feature`/minor).

## Out of scope (explicitly)

- SUBC-009 duplicate churn — duplicate detector worked as designed (fingerprint 1.0, paused).
- SUBC-010/012/013 capacity suspensions — by design; they were collateral of the SUBC-008 wedge.
- SUBC-007/008 SSH/token transport failures — host environment; already repaired and documented by
  the tasks themselves.
- Mission M-MW0Y99TK interview model discipline — covered by FIX-8 at the parser layer; model-side
  prompt hardening is a separate exploration.
