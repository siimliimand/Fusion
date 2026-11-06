import {
  buildTaskExternalBlockClearPatch,
  computeWorkflowIrPin,
  emitBoundedRunAudit,
  isTaskExternallyBlocked,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowIrNode,
  type WorkflowWorkItem,
} from "@fusion/core";
import { generateSyntheticRunId, resolveColumnResumeNode } from "@fusion/engine";
import { conflict, notFound } from "../api-error.js";
import { restartTaskStage } from "./task-restart-stage.js";

const EXTERNAL_BLOCK_RESUME_RUN_SEGMENT = ":external-block-resume:";

type ExternalBlockResumeStore = TaskStore & {
  listWorkflowWorkItemsForTask(taskId: string): Promise<WorkflowWorkItem[]>;
};

export type ResumeExternallyBlockedTaskResult =
  | { kind: "not-blocked" }
  | { kind: "resumed"; task: Task; nodeId: string }
  | { kind: "stale-node"; frozenNodeId: string; entryNodeId: string };

export interface RestartTaskStageEngine {
  clearTaskPauseAbortState?: (taskId: string) => void | Promise<void>;
}

/*
FNXC:ExternalBlockResumeUserPause 2026-11-05-23:04 (KB-008, SUBC-008 R1):
Operator intent outranks the frozen recovery path. An operator-authored pause (`userPaused === true`,
raised by POST /tasks/:id/pause) can sit on a card that also carries external-block freeze metadata;
without this guard, external-block Retry resumed or stage-restarted that card and silently
steamrolled the operator's deliberate pause. Retry must refuse while the pause stands: the refusal
mutates nothing — no continuation publication, no freeze-metadata clear, no task log, no audit row —
and the operator's remedy is Unpause, then Retry. The discriminator is strictly
`userPaused === true`; the freeze's own `paused: true, pausedReason: "external-block"` is recovery
lifecycle state, NOT a user pause, and must never trigger this refusal. The check lives only in this
resume module — the locked preflight below plus the retarget wrapper's live re-read — so
`restartTaskStage` keeps its existing contract for every other Retry surface.
*/
function isPendingExternalBlockResume(item: WorkflowWorkItem): boolean {
  return item.kind === "task"
    && (item.state === "runnable" || item.state === "running" || item.state === "held")
    && typeof item.runId === "string"
    && item.runId.includes(EXTERNAL_BLOCK_RESUME_RUN_SEGMENT);
}

/*
FNXC:ExternalBlockResumeRetarget 2026-11-04-09:34:
A frozen resume node is stale when the card has ADVANCED past the node's column (SUBC-008: the
freeze recorded a WIP node, the executor then finalized the card to review, and republishing the
continuation at that node forced a backward `review → in-progress` column move that lifecycle
containment correctly refused — a guaranteed interpreter error and a dead continuation). The
`ir.columns` order IS the lifecycle order (the same map `resolveColumnResumeNode` walks), so the
comparison is index-based, never node-name-based, and uses the task's resolved workflow.

A node in the task's OWN column (equal index) is NOT stale: republishing it is an in-column
re-entry (`sourceColumn === targetColumn`), no lifecycle move is attempted, and restarting the
stage instead would discard live implementation artifacts for the route's primary recovery shape.
A node in a LATER column (card moved backward since the freeze) also keeps resume-at-node: the
node run's column move is forward and sanctioned. Either index can be unresolvable (v1 IR without
a column model, a node with no column, a card column the workflow does not declare); comparison
then stays impossible and the existing resume-at-node behavior is preserved rather than guessed.
*/
function isResumeNodeBehindTaskColumn(ir: WorkflowIr, taskColumn: string, resumeNode: WorkflowIrNode): boolean {
  if (ir.version !== "v2") return false;
  const columnOrder = new Map(ir.columns.map((entry, index) => [entry.id, index]));
  const taskColumnIndex = columnOrder.get(taskColumn);
  const resumeNodeColumnIndex = resumeNode.column ? columnOrder.get(resumeNode.column) : undefined;
  if (taskColumnIndex === undefined || resumeNodeColumnIndex === undefined) return false;
  return resumeNodeColumnIndex < taskColumnIndex;
}

/*
FNXC:ExternalBlockResume 2026-08-28-04:56:
Retry for an external block is a continuation publication, never a stage restart. It retains every
implementation artifact, keeps the durable pause raised until the successor continuation exists,
and refuses a duplicate request while that continuation is still pending so rapid operator clicks
cannot replay or discard the interrupted step.
*/
export async function resumeExternallyBlockedTask(params: {
  store: ExternalBlockResumeStore;
  taskId: string;
}): Promise<ResumeExternallyBlockedTaskResult> {
  const { store, taskId } = params;
  return store.withPlanningLifecycleLock(taskId, async () => {
    const task = await store.getTask(taskId);
    if (!task) throw notFound(`Task ${taskId} not found`);

    const existingItems = await store.listWorkflowWorkItemsForTask(taskId);
    if (!isTaskExternallyBlocked(task)) {
      if (existingItems.some(isPendingExternalBlockResume)) {
        throw conflict("External-block Retry has already resumed this task");
      }
      return { kind: "not-blocked" };
    }

    const externalBlock = task.externalBlock;
    if (!externalBlock) throw conflict("External-block Retry requires durable obstacle metadata");
    // FNXC:ExternalBlockResumeUserPause 2026-11-05-23:04: refuse before any resolution or
    // publication so a user-paused frozen card is untouched by external-block Retry.
    if (task.userPaused === true) {
      throw conflict("External-block Retry is unavailable: the card is user-paused; unpause it before retrying");
    }
    const ir = await resolveWorkflowIrForTask(store, task.id);
    const resumeNode = externalBlock.resume.nodeId
      ? ir.nodes.find((node) => node.id === externalBlock.resume.nodeId)
      : resolveColumnResumeNode(ir, externalBlock.resume.column);
    if (!resumeNode) {
      throw conflict(`External-block Retry cannot resolve a workflow node for column ${externalBlock.resume.column}`);
    }

    // FNXC:ExternalBlockResumeRetarget 2026-11-04-09:34: publish nothing when the frozen node
    // would force a backward column move — signal the stage-restart retarget with the external
    // block fence still intact, so the sanctioned restart publisher owns every mutation.
    if (isResumeNodeBehindTaskColumn(ir, task.column, resumeNode)) {
      const entryNode = resolveColumnResumeNode(ir, task.column);
      if (!entryNode || entryNode.column !== task.column) {
        throw conflict(`External-block Retry cannot retarget: node ${resumeNode.id} belongs to an earlier column and column ${task.column} has no workflow entry node`);
      }
      return { kind: "stale-node", frozenNodeId: resumeNode.id, entryNodeId: entryNode.id };
    }

    const continuationSequence = existingItems.length;
    const runId = `${taskId}${EXTERNAL_BLOCK_RESUME_RUN_SEGMENT}${resumeNode.id}:${continuationSequence}`;

    // Publish the successor behind the still-intact external-block fence.
    await store.replaceActiveTaskWorkflowContinuation({
      taskId,
      nodeId: resumeNode.id,
      kind: "task",
      state: "runnable",
      waitReason: null,
      blockedReason: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      retryAfter: null,
      sourceColumn: task.column,
      targetColumn: task.column,
      continuationSequence,
      stableWorkflowRunId: `${taskId}:${ir.name}`,
      runId,
      irHash: computeWorkflowIrPin(ir, resumeNode.id).irHash,
    });

    // The continuation now owns resumption, so the obstacle and durable pause can clear together.
    await store.updateTask(taskId, buildTaskExternalBlockClearPatch());
    await store.logEntry(taskId, `External block cleared by dashboard Retry; resuming workflow at ${resumeNode.id}`);
    void emitBoundedRunAudit(store, {
      taskId,
      agentId: "dashboard-api",
      runId: generateSyntheticRunId("external-block-resume", taskId),
      domain: "database",
      mutationType: "task:external-block-cleared",
      target: taskId,
      metadata: {
        taskId,
        origin: externalBlock.origin,
        code: externalBlock.code,
        source: externalBlock.source,
        column: task.column,
        resumeNodeId: resumeNode.id,
      },
    });

    const updated = await store.getTask(taskId);
    if (!updated) throw notFound(`Task ${taskId} not found after external-block Retry`);
    return { kind: "resumed", task: updated, nodeId: resumeNode.id };
  });
}

/*
FNXC:ExternalBlockResumeRetarget 2026-11-04-09:34:
Publication side of the stale-node retarget. This runs OUTSIDE `withPlanningLifecycleLock`
(that lock is not re-entrant and `restartTaskStage` takes it itself), so re-check that the card
is still externally blocked before delegating: a concurrent Retry that resumed the card between
detection and here must conflict instead of restarting a live stage. All mutations — the durable
restart fence, artifact disposal, continuation publication, unfence — belong to the sanctioned
`restartTaskStage` path; this wrapper only clears the now-consumed external-block metadata, logs
the retarget, and emits the FN-209 `task:external-block-cleared` recovery audit.
*/
export async function republishExternalBlockResumeAsStageRestart(params: {
  store: ExternalBlockResumeStore;
  engine?: RestartTaskStageEngine;
  taskId: string;
  stale: Extract<ResumeExternallyBlockedTaskResult, { kind: "stale-node" }>;
  activeMergeTaskId?: string | null;
  getActiveMergeTaskId?: () => string | null;
  staleMergingStatusMinAgeMs?: number;
}): Promise<Task> {
  const { store, engine, taskId, stale } = params;
  const live = await store.getTask(taskId);
  if (!live) throw notFound(`Task ${taskId} not found`);
  if (!isTaskExternallyBlocked(live)) {
    throw conflict("External-block Retry has already resumed this task");
  }
  // FNXC:ExternalBlockResumeUserPause 2026-11-05-23:04: this wrapper runs OUTSIDE the planning
  // lifecycle lock, so its live re-read must re-apply the user-paused refusal: a pause raised
  // between the locked preflight and this republication must not be overridden by the restart.
  if (live.userPaused === true) {
    throw conflict("External-block Retry is unavailable: the card is user-paused; unpause it before retrying");
  }

  const restarted = await restartTaskStage({
    store,
    engine,
    taskId,
    confirm: true,
    onRefusal: "signal",
    activeMergeTaskId: params.activeMergeTaskId ?? null,
    getActiveMergeTaskId: params.getActiveMergeTaskId,
    staleMergingStatusMinAgeMs: params.staleMergingStatusMinAgeMs,
  });
  if ("kind" in restarted) {
    throw conflict(`External-block Retry cannot retarget past node ${stale.frozenNodeId}: ${restarted.reason}`);
  }

  await store.updateTask(taskId, buildTaskExternalBlockClearPatch());
  await store.logEntry(taskId, `External-block resume retargeted: node ${stale.frozenNodeId} belongs to an earlier column; restarting stage at ${stale.entryNodeId}`);
  void emitBoundedRunAudit(store, {
    taskId,
    agentId: "dashboard-api",
    runId: generateSyntheticRunId("external-block-resume", taskId),
    domain: "database",
    mutationType: "task:external-block-cleared",
    target: taskId,
    metadata: {
      taskId,
      origin: live.externalBlock?.origin,
      code: live.externalBlock?.code,
      source: live.externalBlock?.source,
      column: live.column,
      resumeNodeId: stale.entryNodeId,
      retargetedFromNodeId: stale.frozenNodeId,
      outcome: "restart-stage",
    },
  });

  const updated = await store.getTask(taskId);
  if (!updated) throw notFound(`Task ${taskId} not found after external-block retarget`);
  return updated;
}
