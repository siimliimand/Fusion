import type { Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";
import { compareTaskIdNumeric, isTaskBlockedOnApproval, resolveEffectiveAutoMerge } from "@fusion/core";

/*
FNXC:PlanReviewCapacityWake 2026-11-06-06:07 (KB-009 / FIX-12, SUBC-016):

WHY THIS MODULE EXISTS. Under the FN-8453 shared-capacity model a workflow card
suspended at a column boundary writes a durable continuation with `state:"held"` and
`waitReason:"capacity"` (workflow-column-boundary-hooks.ts `onSuspend`). The
scheduler's due-poll drain selects ONLY `states:["runnable","retrying"]`, so that
held row is invisible to every dispatcher, and the only writer that flips it back to
`runnable` was the ~10-minute self-healing reclaim sweep. Meanwhile the triage poll
re-admits fresh intake every ~15s, so each freed slot was claimed by a newer card
before the aged continuation's next attempt — SUBC-016 sat runnable at plan-review
~24h with 239-240 re-seeds while same-evening tasks planned immediately.

This module is the PURE decision shared by the wake-on-release path and the
poll-boundary age-priority path, so "what is wakeable" cannot drift between the two
trigger surfaces — the same drift shape the FN-8592 sweep extracted to avoid.

WHAT IT SELECTS. Only `kind:"task"` rows in state `held` with
`waitReason === "capacity"` and NO `blockedReason`. That population is deliberately
disjoint from the safety-net sweeps: `reconcileStrandedWorkflowContinuations`
targets dead leases / unclaimable holds / retirements and deliberately refuses
`runnable`/`retrying` rows, while `reconcileStrandedHoldContinuations` targets
FN-8592's missing-seed shape (no active continuation at all). Neither sweep's
behavior changes; the wake is additive on top of them.

FENCES (hard requirements, enforced below and by tests):
- no new capacity and no change to the claim model — the wake only flips
  `held → runnable` and lets the EXISTING admission gates (admission coordinator,
  `admitPlanningContinuation`, drain gates) decide whether a dispatch actually
  happens; an over-cap wake attempt flips nothing (CAS loss = skip).
- paused / user-paused / approval-held / `autoMerge:false` / engine-paused /
  terminal / deleted / live tasks are NEVER woken; every refusal names a
  machine-readable reason.
- node-agnostic: no node id is special-cased to identify "plan-review"; the
  selector works for either capacity-suspension site (hold→wip seam and the
  capacity-exhausted real-boundary move park).
- batches are bounded and oldest-first.
*/

/** Maximum rows flipped `held → runnable` per wake attempt. Oldest first. */
export const MAX_CAPACITY_WAKE_BATCH = 5;

/**
 * FNXC:PlanReviewCapacityWake 2026-11-06-06:07 (KB-009 / FIX-12, SUBC-016):
 * Bounded scan window for one wake pass and for the throttle-audit held-row
 * inspection. The selector re-orders and bounds to MAX_CAPACITY_WAKE_BATCH itself;
 * this window only keeps the `held` population scan finite (a board with hundreds
 * of unrelated holds — principal waits, file-scope waits — must not turn the wake
 * or the poll diagnostic into an unbounded scan).
 */
export const CAPACITY_WAKE_SCAN_LIMIT = 50;

/** Machine-readable refusal reasons; every skipped row carries exactly one. */
export type CapacityWakeSkipReason =
  | "not-held"
  | "non-task-kind"
  | "wrong-wait-reason"
  | "blocked-reason"
  | "task-missing"
  | "task-deleted"
  | "task-terminal"
  | "task-paused"
  | "task-user-paused"
  | "awaiting-approval"
  | "engine-paused"
  | "live-task"
  | "auto-merge-off"
  | "too-young";

/** A held capacity continuation the wake may flip back to `runnable`. */
export interface CapacityWakeCandidate {
  item: WorkflowWorkItem;
  task: Task;
  /** Milliseconds the row has been suspended (now − creation, updatedAt fallback). */
  waitedMs: number;
}

export interface CapacityWakeRefusal {
  item: WorkflowWorkItem;
  reason: CapacityWakeSkipReason;
}

export interface SelectCapacityWakeCandidatesInput {
  /** Due `held` rows as returned by `listDueWorkflowWorkItems({ states:["held"] })`. */
  items: readonly WorkflowWorkItem[];
  /** Current time (ms epoch). Injected for determinism. */
  now: number;
  /**
   * Minimum suspended age before a row qualifies. 0 = no age gate
   * (wake-on-release). The poll-boundary priority path passes the resolved
   * `planReviewCapacityWakeAgeMinutes` threshold.
   */
  minAgeMs?: number;
  /** Global/engine pause: while set, nothing is ever woken. */
  enginePaused?: boolean;
  /** Project settings; only `autoMerge` is read (via `resolveEffectiveAutoMerge`). */
  settings: Pick<Settings, "autoMerge">;
  getTask: (taskId: string) => Promise<Task | undefined | null>;
  /** The task's own resolved terminal columns; omitted callers keep the legacy pair. */
  resolveTerminalColumns?: (taskId: string) => Promise<ReadonlySet<string>>;
  /** Caller-proven live execution for the owning task (active session/executor lock). */
  isTaskLive?: (taskId: string) => boolean;
}

export interface SelectCapacityWakeCandidatesResult {
  candidates: CapacityWakeCandidate[];
  refusals: CapacityWakeRefusal[];
}

const LEGACY_TERMINAL_PAIR: ReadonlySet<string> = new Set(["done", "archived"]);

/** Suspended wait for one row; unparseable timestamps yield Number.NaN. */
function suspendedWaitedMs(item: WorkflowWorkItem, now: number): number {
  const raw = Date.parse(item.createdAt ?? "") ;
  const fallback = Date.parse(item.updatedAt ?? "");
  const parsed = Number.isFinite(raw) ? raw : fallback;
  return Number.isFinite(parsed) ? now - parsed : Number.NaN;
}

/** Oldest-first: createdAt asc (≈ waitedMs descending), updatedAt fallback, then numeric/lexical task id. */
function compareCapacityWakeOrder(a: CapacityWakeCandidate, b: CapacityWakeCandidate): number {
  // waitedMs = now − createdAt, so the OLDEST row has the LARGEST wait; NaN (unparseable
  // timestamps) sorts last. Ascending createdAt == descending waitedMs.
  const aTime = Number.isNaN(a.waitedMs) ? Number.NEGATIVE_INFINITY : a.waitedMs;
  const bTime = Number.isNaN(b.waitedMs) ? Number.NEGATIVE_INFINITY : b.waitedMs;
  if (aTime !== bTime) return bTime - aTime;
  const numeric = compareTaskIdNumeric(a.item.taskId, b.item.taskId);
  return numeric !== 0 ? numeric : a.item.taskId.localeCompare(b.item.taskId);
}

/**
 * FNXC:PlanReviewCapacityWake 2026-11-06-06:07:
 * Select the capacity-suspended continuations a wake attempt may flip back to
 * `runnable`, ordered oldest-first and bounded to {@link MAX_CAPACITY_WAKE_BATCH}.
 *
 * Pure: every store access is injected, so the wake rules are exercisable without
 * constructing a runtime (whose construction attaches to the real project registry).
 * The result is advisory only — flipping a row to `runnable` hands it to the
 * existing drain, whose admission gates remain the sole dispatch authority.
 */
export async function selectCapacityWakeCandidates(
  input: SelectCapacityWakeCandidatesInput,
): Promise<SelectCapacityWakeCandidatesResult> {
  const candidates: CapacityWakeCandidate[] = [];
  const refusals: CapacityWakeRefusal[] = [];
  const minAgeMs = input.minAgeMs ?? 0;

  if (input.enginePaused === true) {
    // A paused engine must not wake anything: return early without even per-row
    // classification work, mirroring the drain's own engine-pause gate.
    for (const item of input.items) refusals.push({ item, reason: "engine-paused" });
    return { candidates, refusals };
  }

  const taskCache = new Map<string, Task | undefined | null>();
  const loadTask = async (taskId: string): Promise<Task | undefined | null> => {
    if (!taskCache.has(taskId)) {
      taskCache.set(taskId, await input.getTask(taskId).catch(() => undefined));
    }
    return taskCache.get(taskId);
  };

  for (const item of input.items) {
    if (item.state !== "held") {
      refusals.push({ item, reason: "not-held" });
      continue;
    }
    if (item.kind !== "task") {
      // `manual-hold` is operator-owned; only task continuations are wakeable.
      refusals.push({ item, reason: "non-task-kind" });
      continue;
    }
    // `waitReason:"planning"`/null rows are other flows' work (deferral, triage
    // ownership); the wake owns exactly the capacity-suspension shape.
    if (item.waitReason !== "capacity") {
      refusals.push({ item, reason: "wrong-wait-reason" });
      continue;
    }
    // `workflow-principal-*` / `file-scope:*` / `dependency:*` blockers are owned
    // by their own release paths (holdWorkflowAdmission,
    // settlePlanningContinuationDispatch + releaseFileScopeWaitingContinuations),
    // never by `onSuspend`; a blockedReason-bearing held row is not capacity-waiting.
    if (item.blockedReason != null && item.blockedReason.length > 0) {
      refusals.push({ item, reason: "blocked-reason" });
      continue;
    }

    const task = await loadTask(item.taskId);
    if (task == null) {
      refusals.push({ item, reason: "task-missing" });
      continue;
    }
    if (task.deletedAt) {
      refusals.push({ item, reason: "task-deleted" });
      continue;
    }
    const terminal = input.resolveTerminalColumns
      ? await input.resolveTerminalColumns(item.taskId).catch(() => undefined)
      : undefined;
    const terminalSet = terminal ?? LEGACY_TERMINAL_PAIR;
    // Set-only, matching resolvePlanningContinuationCandidate: the resolved lifecycle
    // columns REPLACE the legacy pair on renamed boards, never merge with it.
    if (terminalSet.has(task.column)) {
      refusals.push({ item, reason: "task-terminal" });
      continue;
    }
    if (task.paused === true) {
      refusals.push({ item, reason: "task-paused" });
      continue;
    }
    if (task.userPaused === true) {
      refusals.push({ item, reason: "task-user-paused" });
      continue;
    }
    if (isTaskBlockedOnApproval(task)) {
      refusals.push({ item, reason: "awaiting-approval" });
      continue;
    }
    if (input.isTaskLive?.(item.taskId) === true) {
      // An already-live task must not be double-dispatched; its held row (if any)
      // is owned by its own run's completion path.
      refusals.push({ item, reason: "live-task" });
      continue;
    }
    if (resolveEffectiveAutoMerge(task, input.settings) === false) {
      // An operator opted this card out of automatic progression; wake-on-release
      // must never start it behind their back (FN-5147 posture).
      refusals.push({ item, reason: "auto-merge-off" });
      continue;
    }

    const waitedMs = suspendedWaitedMs(item, input.now);
    if (Number.isFinite(waitedMs) && waitedMs < minAgeMs) {
      refusals.push({ item, reason: "too-young" });
      continue;
    }
    candidates.push({ item, task, waitedMs });
  }

  candidates.sort(compareCapacityWakeOrder);
  const bounded = candidates.slice(0, MAX_CAPACITY_WAKE_BATCH);
  return { candidates: bounded, refusals };
}

/** Oldest suspended wait for the throttle audit; null when no row is waiting. */
export interface OldestSuspendedCapacityInspection {
  count: number;
  oldestWaitMs: number | null;
}

/** Everything the capacity-wake pass touches, injected so the pass is exercisable
 *  without constructing a runtime (which would attach to the real project registry). */
export interface CapacityWakePassDeps {
  store: TaskStore;
  /** Invoked ONCE when at least one row flipped `held → runnable`, so the freshly
   *  runnable rows are dispatched without waiting for the next due poll. */
  drain: () => Promise<void>;
  now?: () => number;
  resolveTerminalColumns?: (taskId: string) => Promise<ReadonlySet<string>>;
  isTaskLive?: (taskId: string) => boolean;
  warn: (message: string) => void;
}

/**
 * FNXC:PlanReviewCapacityWake 2026-11-06-06:07:
 * Inspect the suspended-capacity population for the `task:plan-admission-throttled`
 * audit: how many rows are waiting and how long the oldest has waited. Read-only —
 * answers "why did this card sit queued?" for the capacity gate with the same
 * ids/counts-only contract the throttle event already keeps.
 */
export function inspectOldestSuspendedCapacityContinuation(
  items: readonly WorkflowWorkItem[],
  now: number,
): OldestSuspendedCapacityInspection {
  let count = 0;
  let oldestWaitMs: number | null = null;
  for (const item of items) {
    if (item.state !== "held" || item.kind !== "task" || item.waitReason !== "capacity") continue;
    count += 1;
    const waitedMs = suspendedWaitedMs(item, now);
    if (!Number.isFinite(waitedMs)) continue;
    if (oldestWaitMs === null || waitedMs > oldestWaitMs) oldestWaitMs = waitedMs;
  }
  return { count, oldestWaitMs };
}
