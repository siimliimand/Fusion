import { rm } from "node:fs/promises";
import {
  computeWorkflowIrPin,
  disposeTaskBeforeReset,
  planTaskColumnRestart,
  RESTART_STAGE_FENCE_REASON,
  resolveTaskSymbolsForTask,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
} from "@fusion/core";
import { classifyPostMergeGateRetryOutcome, isMergeActiveStatus, isStaleMergeActiveStatus, resolveColumnResumeNode, resumeMissingPostMergeGate, type PostMergeGateResumeBlockReason } from "@fusion/engine";
import { badRequest, conflict, notFound } from "../api-error.js";

/*
FNXC:RetryRefusalReasons 2026-11-04-10:12 (FIX-4, SUBC-008):
The landed-verification retry used to throw ONE hard-coded conflict for every refused reseed, so an
operator staring at an orphaned work item was told the gate was "pending, active, held, or already
approved" — none of which was true, and the only recovery was waiting out the hourly backoff or raw
SQL. Each machine reason now maps to the guard that actually fired. `not-due` is the only reason
that keeps the original "landing proof is preserved" message, because it is the only reason that
means the gate is genuinely approved/pending (an explicit operator Retry with a failed gate bypasses
the backoff upstream and never produces "not-due"). The active-work-items message may promise
"self-healing will fail it" because the FIX-3 sweep owns exactly that repair on this branch.
*/
const POST_MERGE_RECHECK_REFUSAL_MESSAGES: Record<PostMergeGateResumeBlockReason, string> = {
  "merge-active": "Retry is unavailable while a merge is active",
  "lease-fresh": "Post-merge verification recheck is blocked: a fresh checkout lease still owns this card; retry after it finishes",
  "execution-live": "Post-merge verification recheck is blocked: the task is executing live and its run will reach the gate; retry after it finishes",
  "finalize-blocker": "Post-merge verification recheck is blocked: the card carries an independent blocking status; resolve it first",
  "active-work-items": "Post-merge verification recheck blocked by an active workflow work item that still owns the graph — self-healing will fail orphans; retry after",
  "workflow-selection-changed": "Post-merge verification recheck is blocked: the task's workflow selection changed; the failed gate stays parked for reclassification",
  "not-due": "Post-merge verification cannot be retried while pending, active, held, or already approved; landing proof is preserved",
};

function postMergeRecheckRefusalMessage(resumed: Extract<Awaited<ReturnType<typeof resumeMissingPostMergeGate>>, { outcome: "not-resumable" }>): string {
  if (resumed.reason !== "active-work-items" || !resumed.workItem) return POST_MERGE_RECHECK_REFUSAL_MESSAGES[resumed.reason];
  const { id, kind, state } = resumed.workItem;
  return `Post-merge verification recheck blocked: active workflow work item ${id ?? "(unknown id)"} (${kind}, state ${state}) belongs to a dead run — self-healing will fail it; retry after`;
}

interface RestartTaskStageEngine {
  clearTaskPauseAbortState?: (taskId: string) => void | Promise<void>;
}

type RestartTaskStageStore = TaskStore & {
  clearWorkflowRunStepInstancesAsync?: (taskId: string) => Promise<void>;
};

export interface RestartTaskStageDeps {
  store: RestartTaskStageStore;
  engine?: RestartTaskStageEngine;
  taskId: string;
  confirm?: boolean;
  onRefusal?: "throw" | "signal";
  activeMergeTaskId?: string | null;
  getActiveMergeTaskId?: () => string | null;
  staleMergingStatusMinAgeMs?: number;
}

export type RestartTaskStageResult = Task | Extract<ReturnType<typeof planTaskColumnRestart>, { kind: "refused" }>;

function refusalError(plan: Extract<ReturnType<typeof planTaskColumnRestart>, { kind: "refused" }>) {
  if (plan.reason === "no-entry-node-in-column") {
    const later = plan.detail?.resolvedEntryNodeColumn;
    return badRequest(later
      ? `The ${later} workflow node is later than the task's ${plan.detail?.resolvedEntryNodeColumn === later ? "current" : ""} column; this stage cannot be retried in place`
      : "This column has no workflow entry node and cannot be retried in place");
  }
  return badRequest(`Retry is unavailable: ${plan.reason}`);
}

/*
FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
Retry is the operator name for this in-place stage restart. The module name and
`RESTART_STAGE_FENCE_REASON` remain stable internal/durable identifiers so already parked cards
with `restart-stage-publishing` are recognized and can safely resume publication.

FNXC:ColumnRestart 2026-08-27-23:23:
Restart publishes task state and a workflow continuation through separate durable writes, so write
ordering alone cannot prevent a dispatcher from observing stale artifacts with a new continuation,
or a discarded row through an old continuation. A durable pause is the publication fence every
existing dispatcher and merge gate already honours: W1 raises it before cancellation and W6 lowers
it only after the successor is armed. Re-read the task after W1 before disposing its runtime owner;
production reads materialize a new row, so the pre-fence validation snapshot cannot prove that the
disposer operates behind the durable fence.

A crash between those writes intentionally leaves `restart-stage-publishing` parked and visible.
No automatic sweep owns this reason; rerunning the operator action reuses the same filter and
replace primitive. PROMPT.md deletion is W4, after the durable plan patch and before arm/unfence,
so neither an unmarked plan nor a freshly replanned prompt can be removed. This route adds no new
run-audit mutation: reset/retry use task log entries and pause lifecycle records already provide
the operator audit trail.

FNXC:MergeReliability 2026-08-28-15:15:
The restart fence uses `isMergeActiveStatus` from
`packages/engine/src/merge/merge-active-status.ts` so every merge phase, including the long-running
AI review phase, shares one definition and cannot drift open. The stale-stamp bypass is unchanged:
an orphaned stamp in any phase remains retryable after the shared liveness and age proof passes.

FNXC:MergeReliability 2026-08-28-15:51:
The initial merge check is only an early refusal; a merger can claim the task before Retry raises
its durable pause. Claim the publication fence with `updateTaskAtomic` and classify the exact
lock-held snapshot with the same active/stale predicate and a fresh in-process lease read before
disposing any runtime or publishing restart artifacts. If that snapshot or lease is merge-active,
restore the prior pause fields and return the same conflict so Retry never interrupts a merger that
won the race. The ordinary `pauseTask` write still follows for admitted retries so pause lifecycle
logging and WIP/review presentation remain unchanged.
*/
function isLiveMergeRestart(task: Task, deps: RestartTaskStageDeps): boolean {
  const activeMergeTaskId = deps.getActiveMergeTaskId?.() ?? deps.activeMergeTaskId ?? null;
  if (activeMergeTaskId === task.id) return true;
  return isMergeActiveStatus(task.status) && !isStaleMergeActiveStatus(task, {
    activeMergeTaskId,
    minAgeMs: deps.staleMergingStatusMinAgeMs,
  });
}

export async function restartTaskStage(deps: RestartTaskStageDeps): Promise<RestartTaskStageResult> {
  const { store, engine, taskId, confirm } = deps;
  if (confirm !== true) {
    throw badRequest("Retry discards work produced in the current stage. Pass { \"confirm\": true } to proceed.");
  }

  return store.withPlanningLifecycleLock(taskId, async () => {
    let publicationStep = "validate";
    let fenced = false;
    try {
      const task = await store.getTask(taskId);
      if (!task) throw notFound(`Task ${taskId} not found`);
      const retryLandedVerification = async (landedTask: Task): Promise<Task> => {
        if (isLiveMergeRestart(landedTask, deps)) {
          /*
          FNXC:RetryOutcomeClassification 2026-11-06-01:32 (KB-007, SUBC-008):
          This early guard is a landed-verification retry outcome like any other: once the merge
          finishes, a later retry can act, so it classifies as deferred, is audited in the task
          log, and carries its reason in the body — the operator sees the same classified contract
          whether this guard or the seeder's merge-active guard refused. Message text unchanged.
          */
          await store.logEntry(taskId, "Retry requested from dashboard (post-merge recheck deferred: merge-active)").catch(() => undefined);
          throw conflict("Retry is unavailable while a merge is active", { outcome: "deferred", reason: "merge-active" });
        }
        /*
        FNXC:RetryOutcomeClassification 2026-11-05-21:41 (KB-007, SUBC-008):
        A paused landed card used to fall through to the seeder and come back as "not-due" — a
        message naming four states (pending, active, held, approved) none of which was the actual
        pause. The manual door now names the truth before invoking the seeder. `card-paused` and
        `engine-paused` are ROUTE-LOCAL reason vocabulary living only in this refusal's details —
        the engine's PostMergeGateResumeBlockReason union stays closed and its own guards remain
        the automatic-lane backstop; this route check exists only to name the truth on the manual
        door. Deleted cards still fall through to the seeder (their truth is landing-proof
        preservation, not a pause).
        */
        if (landedTask.paused || landedTask.userPaused) {
          await store.logEntry(taskId, "Retry requested from dashboard (post-merge recheck refused: card-paused)").catch(() => undefined);
          throw conflict("Retry is unavailable while the card is paused; resume it, then retry", { outcome: "refused", reason: "card-paused" });
        }
        /*
        FNXC:RetryOutcomeClassification 2026-11-05-21:41 (KB-007, SUBC-008):
        An engine/global pause likewise reached the operator as "not-due". Reading settings on the
        manual door lets the refusal name the pause and the exact remedy while the seeder's own
        guard continues to protect every automatic caller unchanged.
        */
        const settings = await store.getSettings();
        if (settings.globalPause || settings.enginePaused) {
          await store.logEntry(taskId, "Retry requested from dashboard (post-merge recheck refused: engine-paused)").catch(() => undefined);
          throw conflict("Retry is unavailable while the engine (or all projects) is paused; resume it, then retry", { outcome: "refused", reason: "engine-paused" });
        }
        const resumed = await resumeMissingPostMergeGate(store, taskId, { manualRetry: true });
        if (resumed.outcome !== "resumed") {
          /*
          FNXC:RetryOutcomeClassification 2026-11-05-21:41 (KB-007, SUBC-008):
          A refusal that leaves no trace and no machine-readable outcome is a success-shaped
          no-op: the operator cannot tell a wait-it-out deferral from a change-something refusal,
          and the card's log never records the attempt. Every landed-verification retry outcome is
          now classified (classifyPostMergeGateRetryOutcome), written to the task log best-effort,
          and carried in the ApiError details; the message text stays byte-identical.
          */
          const outcome = classifyPostMergeGateRetryOutcome(resumed.reason);
          await store.logEntry(taskId, `Retry requested from dashboard (post-merge recheck ${outcome}: ${resumed.reason})`).catch(() => undefined);
          throw conflict(postMergeRecheckRefusalMessage(resumed), {
            outcome,
            reason: resumed.reason,
            ...(resumed.workItem ? { workItem: resumed.workItem } : {}),
          });
        }
        /*
        FNXC:RetryOutcomeClassification 2026-11-05-21:41 (KB-007, SUBC-008):
        The seeder's own `[post-merge] Rechecking…` entry stays unchanged; this entry attributes
        the reseed to the operator's Retry so the card's log shows who triggered the recheck.
        */
        await store.logEntry(taskId, `Retry requested from dashboard (post-merge gate '${resumed.gateId}' reseeded for verification recheck)`).catch(() => undefined);
        return store.getTask(taskId);
      };
      if (task.mergeDetails?.mergeConfirmed) return retryLandedVerification(task);
      const ir = await resolveWorkflowIrForTask(store, task.id);
      const entryNode = resolveColumnResumeNode(ir, task.column);
      const plan = planTaskColumnRestart({ task, ir, entryNode });
      if (plan.kind === "refused") {
        if (deps.onRefusal === "signal") return plan;
        throw refusalError(plan);
      }
      if (isLiveMergeRestart(task, deps)) {
        throw conflict("Retry is unavailable while a merge is active");
      }

      publicationStep = "raise publication fence";
      let mergeActiveAtFence = false;
      let priorPaused: Task["paused"];
      let priorPausedReason: Task["pausedReason"];
      let landedAtFence: Task | undefined;
      await store.updateTaskAtomic(taskId, (fenceSnapshot) => {
        // Landing may finish after the initial read; never discard its new proof.
        if (fenceSnapshot.mergeDetails?.mergeConfirmed) {
          landedAtFence = fenceSnapshot;
          return null;
        }
        priorPaused = fenceSnapshot.paused;
        priorPausedReason = fenceSnapshot.pausedReason;
        mergeActiveAtFence = isLiveMergeRestart(fenceSnapshot, deps);
        return {
          paused: true,
          pausedReason: RESTART_STAGE_FENCE_REASON,
        };
      });
      if (landedAtFence) return retryLandedVerification(landedAtFence);
      fenced = true;

      if (mergeActiveAtFence) {
        publicationStep = "release publication fence after merge claim";
        await store.updateTaskAtomic(taskId, (current) => {
          if (current.pausedReason !== RESTART_STAGE_FENCE_REASON) return null;
          return {
            paused: priorPaused ?? (null as unknown as Task["paused"]),
            pausedReason: priorPausedReason ?? (null as unknown as Task["pausedReason"]),
          };
        });
        fenced = false;
        throw conflict("Retry is unavailable while a merge is active");
      }

      await store.pauseTask(taskId, true, undefined, { pausedReason: RESTART_STAGE_FENCE_REASON });
      const fencedTask = await store.getTask(taskId);
      if (!fencedTask) throw notFound(`Task ${taskId} not found after fencing`);

      publicationStep = "dispose active runtime owner";
      await Promise.resolve(engine?.clearTaskPauseAbortState?.(taskId));
      await disposeTaskBeforeReset(store, fencedTask);

      publicationStep = "confirm restart target";
      const freshTask = await store.getTask(taskId);
      if (!freshTask || freshTask.column !== task.column || resolveColumnResumeNode(ir, freshTask?.column)?.id !== plan.entryNodeId) {
        await store.pauseTask(taskId, false);
        fenced = false;
        throw conflict("Retry target changed while cancellation was settling; retry safely");
      }

      publicationStep = "clear restart boundaries";
      await store.resetTerminalFailureAutoRecoveryBudget(taskId);
      await store.clearWorkflowRunStepInstancesAsync?.(taskId);
      if (plan.releaseSymbolLocks) {
        const symbols = resolveTaskSymbolsForTask(freshTask);
        if (symbols.resolvable) await store.releaseSymbolLocks?.(symbols.symbols, taskId);
      }

      publicationStep = "retire predecessor continuations";
      await store.cancelActiveWorkflowWorkItemsForTask(taskId, {
        kinds: ["task"],
        lastError: "restart-stage-fence",
      });

      publicationStep = "publish discarded stage artifacts";
      await store.updateTask(taskId, {
        ...plan.patch,
        paused: true,
        pausedReason: RESTART_STAGE_FENCE_REASON,
      });

      publicationStep = "remove superseded prompt";
      if (plan.deletePrompt) {
        const promptPath = `${store.getRootDir()}/.fusion/tasks/${taskId}/PROMPT.md`;
        await rm(promptPath, { force: true });
      }

      publicationStep = "arm workflow continuation";
      const continuationSequence = (await store.listWorkflowWorkItemsForTask(taskId)).length;
      await store.replaceActiveTaskWorkflowContinuation({
        taskId,
        nodeId: plan.entryNodeId,
        kind: "task",
        state: "runnable",
        waitReason: null,
        blockedReason: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        retryAfter: null,
        sourceColumn: freshTask.column,
        targetColumn: freshTask.column,
        continuationSequence,
        stableWorkflowRunId: `${taskId}:${ir.name}`,
        runId: `${taskId}:restart-stage:${plan.entryNodeId}:${continuationSequence}`,
        irHash: computeWorkflowIrPin(ir, plan.entryNodeId).irHash,
      });

      publicationStep = "lower publication fence";
      await store.pauseTask(taskId, false);
      fenced = false;
      const preservedWorkspaceRepositoryRecords = Object.keys(task.workspaceWorktrees ?? {}).length;
      await store.logEntry(taskId, `Retry requested from dashboard (${plan.scope} restart in ${task.column}, discarded ${plan.discardedWorkflowStepIds.length} workflow step result(s), preserved ${preservedWorkspaceRepositoryRecords} workspace repository record(s), re-entering at ${plan.entryNodeId})`);
      const updated = await store.getTask(taskId);
      if (!updated) throw notFound(`Task ${taskId} not found after retry`);
      return updated;
    } catch (error) {
      if (fenced) {
        await store.logEntry(taskId, `Retry publication parked at ${publicationStep}; rerun Retry safely`).catch(() => undefined);
        if (error instanceof Error && ("status" in error)) throw error;
        throw conflict(`Retry paused at ${publicationStep}; the card is parked with ${RESTART_STAGE_FENCE_REASON} and can be retried safely`);
      }
      throw error;
    }
  });
}
