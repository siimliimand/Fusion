/*
FNXC:MemoryWedge 2026-11-06-13:30:
PostgreSQL integration coverage for the KB-010 (FIX-13) terminal-conversation trim.
Pins the accumulator invariant against the real jsonb SQL:

1. Every transition INTO a terminal status (`complete`/`error`) bounds
   conversation_history to its LAST TERMINAL_CONVERSATION_TAIL_ENTRIES entries
   (tail, never head), across ALL three terminal-transition writers:
   updateAiSessionStatus (status-only updates), upsertAiSession (whole-row
   persistSession writes from planning/interview flows), and
   recoverStaleAiSessions (boot orphan recovery to error).
2. Non-terminal transitions (`awaiting_input`, `generating`) NEVER trim.
3. Short and empty histories are left unchanged (the jsonpath range clamps to
   the whole array; empty stays []) — the trim must not error on edge shapes.
4. The guarded conditional UPDATE means a racing non-terminal status write is
   never trimmed.
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  getAiSession,
  recoverStaleAiSessions,
  trimTerminalAiSessionConversationHistory,
  TERMINAL_CONVERSATION_TAIL_ENTRIES,
  updateAiSessionStatus,
  upsertAiSession,
  type AiSessionRow,
} from "../../async-stores/async-ai-session-store.js";

const pgTest = pgDescribe;

type Db = AsyncDataLayer["db"];

function historyOf(length: number): string {
  return JSON.stringify(
    Array.from({ length }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", index: i })),
  );
}

async function seedSession(db: Db, overrides: Partial<AiSessionRow> & { id: string }): Promise<AiSessionRow> {
  const now = new Date().toISOString();
  const row: AiSessionRow = {
    id: overrides.id,
    type: "planning",
    status: "generating",
    title: "KB-010 trim fixture",
    inputPayload: JSON.stringify({ initialPlan: "Build the thing" }),
    conversationHistory: historyOf(0),
    currentQuestion: null,
    result: null,
    thinkingOutput: "",
    error: null,
    projectId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as AiSessionRow;
  await upsertAiSession(db, row);
  return row;
}

async function storedHistory(db: Db, id: string): Promise<unknown[]> {
  const row = await getAiSession(db, id);
  expect(row).not.toBeNull();
  return JSON.parse((row as AiSessionRow).conversationHistory) as unknown[];
}

pgTest("ai_session terminal conversation trim (KB-010 FIX-13)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_ai_session_trim",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("trims a 60-entry history to the LAST 50 on complete", async () => {
    const db = h.layer().db;
    const id = "trim-complete-60";
    await seedSession(db, { id, status: "generating", conversationHistory: historyOf(60) });

    const changed = await updateAiSessionStatus(db, id, "complete");
    expect(changed).toBe(true);

    const history = await storedHistory(db, id);
    expect(history).toHaveLength(TERMINAL_CONVERSATION_TAIL_ENTRIES);
    // Tail, not head: the first retained entry is index 10 of the original 60.
    expect((history[0] as { index: number }).index).toBe(60 - TERMINAL_CONVERSATION_TAIL_ENTRIES);
    expect((history[history.length - 1] as { index: number }).index).toBe(59);
  });

  it("trims a 60-entry history to the LAST 50 on error", async () => {
    const db = h.layer().db;
    const id = "trim-error-60";
    await seedSession(db, { id, status: "generating", conversationHistory: historyOf(60) });

    const changed = await updateAiSessionStatus(db, id, "error", "model failure");
    expect(changed).toBe(true);

    const history = await storedHistory(db, id);
    expect(history).toHaveLength(TERMINAL_CONVERSATION_TAIL_ENTRIES);
    expect((history[0] as { index: number }).index).toBe(60 - TERMINAL_CONVERSATION_TAIL_ENTRIES);
  });

  it("never trims a non-terminal transition (generating -> awaiting_input)", async () => {
    const db = h.layer().db;
    const id = "trim-nonterminal";
    await seedSession(db, { id, status: "generating", conversationHistory: historyOf(60) });

    const changed = await updateAiSessionStatus(db, id, "awaiting_input");
    expect(changed).toBe(true);

    const history = await storedHistory(db, id);
    expect(history).toHaveLength(60);
    expect((history[0] as { index: number }).index).toBe(0);
  });

  it("leaves histories shorter than the tail unchanged and tolerates an empty history", async () => {
    const db = h.layer().db;
    const shortId = "trim-short-49";
    await seedSession(db, { id: shortId, status: "generating", conversationHistory: historyOf(49) });
    await updateAiSessionStatus(db, shortId, "complete");
    const shortHistory = await storedHistory(db, shortId);
    expect(shortHistory).toHaveLength(49);
    expect((shortHistory[0] as { index: number }).index).toBe(0);

    const emptyId = "trim-empty";
    await seedSession(db, { id: emptyId, status: "generating", conversationHistory: "[]" });
    await expect(updateAiSessionStatus(db, emptyId, "complete")).resolves.toBe(true);
    await expect(storedHistory(db, emptyId)).resolves.toEqual([]);
  });

  it("trims a terminal whole-row upsert (the dominant persistSession writer)", async () => {
    const db = h.layer().db;
    const id = "trim-upsert-terminal";
    const now = new Date().toISOString();
    await upsertAiSession(db, {
      id,
      type: "mission_interview",
      status: "complete",
      title: "Interview done",
      inputPayload: "{}",
      conversationHistory: historyOf(70),
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: now,
      updatedAt: now,
    } as AiSessionRow);

    const history = await storedHistory(db, id);
    expect(history).toHaveLength(TERMINAL_CONVERSATION_TAIL_ENTRIES);
    expect((history[0] as { index: number }).index).toBe(70 - TERMINAL_CONVERSATION_TAIL_ENTRIES);

    // A non-terminal whole-row upsert must keep the full history.
    const activeId = "upsert-nonterminal-kept";
    await upsertAiSession(db, {
      id: activeId,
      type: "mission_interview",
      status: "generating",
      title: "Interview running",
      inputPayload: "{}",
      conversationHistory: historyOf(70),
      currentQuestion: "next?",
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: now,
      updatedAt: now,
    } as AiSessionRow);
    await expect(storedHistory(db, activeId)).resolves.toHaveLength(70);
  });

  it("trims sessions recoverStaleAiSessions orphans to error, but not the revived ones", async () => {
    const db = h.layer().db;
    const orphanedId = "trim-recovered-error";
    await seedSession(db, { id: orphanedId, status: "generating", conversationHistory: historyOf(80) });
    const revivedId = "trim-recovered-awaiting";
    await seedSession(db, {
      id: revivedId,
      status: "generating",
      conversationHistory: historyOf(80),
      currentQuestion: "still wants an answer",
    });

    const recovered = await recoverStaleAiSessions(db);
    expect(recovered).toBe(2);

    // The no-question orphan went to error: trimmed to the terminal tail.
    const errorHistory = await storedHistory(db, orphanedId);
    expect(errorHistory).toHaveLength(TERMINAL_CONVERSATION_TAIL_ENTRIES);
    expect((errorHistory[0] as { index: number }).index).toBe(80 - TERMINAL_CONVERSATION_TAIL_ENTRIES);

    // The with-question session went to awaiting_input: full history kept.
    await expect(storedHistory(db, revivedId)).resolves.toHaveLength(80);
  });

  it("does not trim a row whose status raced back to non-terminal before the trim fires", async () => {
    const db = h.layer().db;
    const id = "trim-race-guard";
    await seedSession(db, { id, status: "generating", conversationHistory: historyOf(60) });

    // Simulate the race: another process revives the row between the terminal
    // transition and the guarded trim UPDATE. Invoke the trim directly while the
    // row is non-terminal — the status WHERE guard must make it a no-op.
    const trimmed = await trimTerminalAiSessionConversationHistory(db, id);
    expect(trimmed).toBe(false);
    await expect(storedHistory(db, id)).resolves.toHaveLength(60);
  });
});
