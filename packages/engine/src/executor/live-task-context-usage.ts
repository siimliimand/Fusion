/**
 * FNXC:BoardContextUsage 2026-11-12-10:59:
 * Live per-task AI context-window occupancy collector for the board payload.
 *
 * Reads the executor's live session surfaces (`activeSessions` task sessions
 * and `activeWorkflowStepSessions` workflow-step sessions — both hold pi
 * AgentSessions exposing `getContextUsage()`) and snapshots each task's
 * current context-window occupancy. Pure and synchronous so `GET /api/tasks`
 * can call it inline with no IO and no lifecycle risk.
 *
 * Semantics:
 * - Only tasks with a live session appear in the result; idle tasks are
 *   absent so consumers render nothing rather than stale data.
 * - pi reports `tokens`/`percent` as null right after compaction until the
 *   next assistant reply; such sessions are omitted (unknown, not zero).
 * - Counts-only output: tokens, contextWindow, percent. Never prompt,
 *   transcript, or model-identity content.
 * - Best-effort: a throwing accessor or malformed usage skips that task and
 *   never fails the board load.
 */
import type { TaskContextUsageSnapshot } from "@fusion/core";

/** Live session surfaces the executor holds; values may be any session shape. */
export interface LiveTaskContextUsageDeps {
  /** Task-keyed executor sessions (`ActiveExecutorSessionState` with `.session`). */
  activeSessions: Map<string, unknown>;
  /** Task-keyed workflow-step sessions (raw AgentSession values). */
  activeWorkflowStepSessions: Map<string, unknown>;
}

interface NormalizedUsage {
  snapshot: TaskContextUsageSnapshot;
}

/**
 * Defensively normalize a `getContextUsage()` result. Mirrors the shape
 * documented in chat.ts: `{ tokens: number | null; contextWindow: number;
 * percent: number | null } | undefined`. Returns undefined when occupancy is
 * unknown (missing accessor, null tokens, non-finite numbers) so unknown is
 * never presented as zero.
 */
function normalizeUsage(raw: unknown): NormalizedUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as { tokens?: unknown; contextWindow?: unknown; percent?: unknown };

  const tokens = usage.tokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined;

  const contextWindowRaw = usage.contextWindow;
  const hasWindow =
    typeof contextWindowRaw === "number" && Number.isFinite(contextWindowRaw) && contextWindowRaw > 0;

  const tokensTrunc = Math.trunc(tokens);
  if (!hasWindow) {
    return { snapshot: { tokens: tokensTrunc } };
  }

  const contextWindow = Math.trunc(contextWindowRaw);
  const percentRaw = usage.percent;
  const percent =
    typeof percentRaw === "number" && Number.isFinite(percentRaw)
      ? Math.min(100, Math.max(0, Math.round(percentRaw)))
      : Math.min(100, Math.max(0, Math.round((tokens / contextWindowRaw) * 100)));
  return { snapshot: { tokens: tokensTrunc, contextWindow, percent } };
}

/** Read `getContextUsage()` best-effort; a throwing accessor means unknown. */
function readUsage(session: unknown): unknown {
  try {
    const accessor = (session as { getContextUsage?: () => unknown } | null)?.getContextUsage;
    return typeof accessor === "function" ? accessor.call(session) : undefined;
  } catch {
    return undefined;
  }
}

/** Extract the pi AgentSession from an `activeSessions` entry (`.session`). */
function sessionOf(state: unknown): unknown {
  if (typeof state === "object" && state !== null && "session" in state) {
    return (state as { session?: unknown }).session;
  }
  return state;
}

/**
 * Snapshot context usage for every task with a live session. `activeSessions`
 * wins over `activeWorkflowStepSessions` for the same task: the task session
 * is the authoritative implementation conversation when both surfaces hold a
 * session mid-handoff.
 */
export function collectLiveTaskContextUsage(
  deps: LiveTaskContextUsageDeps,
): Map<string, TaskContextUsageSnapshot> {
  const usageByTask = new Map<string, TaskContextUsageSnapshot>();

  for (const [taskId, state] of deps.activeSessions) {
    const snapshot = normalizeUsage(readUsage(sessionOf(state)));
    if (snapshot) usageByTask.set(taskId, snapshot.snapshot);
  }

  for (const [taskId, session] of deps.activeWorkflowStepSessions) {
    if (usageByTask.has(taskId)) continue;
    const snapshot = normalizeUsage(readUsage(session));
    if (snapshot) usageByTask.set(taskId, snapshot.snapshot);
  }

  return usageByTask;
}
