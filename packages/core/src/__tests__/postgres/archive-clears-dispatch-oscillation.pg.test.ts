/**
 * FNXC:SchedulerDispatchOscillation 2026-11-04-10:09 (FIX-10):
 * PostgreSQL integration proof that the archive transition owns the scheduler's oscillation
 * reset. Original symptom (journal 2026-11-03 17:21:16 CET): archiving a card with oscillation
 * state soft-deleted the row first, so the scheduler's follow-up reset write was refused —
 * "Failed to reset dispatch oscillation state for SUBC-007 on move to archived: Task SUBC-007
 * is soft-deleted ..." — leaving stale state on the archived row/snapshot.
 *
 * Asserted here end-to-end against a real store: seeding a done card with oscillation state
 * and archiving it (1) applies the soft-delete, (2) leaves NO persisted oscillation columns on
 * the archived row, and (3) emits a `task:moved` payload whose task carries cleared fields, so
 * the scheduler's post-move reset has nothing to attempt (hence no failed-write warning).
 *
 * Skips when PostgreSQL is unreachable (pgDescribe), matching the repo's PG harness contract.
 */
import { describe, it, expect, afterEach } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import {
  createTaskStoreForTest,
  PG_AVAILABLE,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { writeProjectConfig } from "../../task-store/async/async-settings.js";

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

pgDescribe("archive clears dispatch oscillation state (PostgreSQL integration)", () => {
  let h: PgTestHarness | null = null;

  afterEach(async () => {
    if (h) {
      await h.teardown();
      h = null;
    }
  });

  it("archives a done card with oscillation state: soft-delete applied, persisted oscillation columns cleared, event payload clean", async () => {
    h = await createTaskStoreForTest({ prefix: "arch_osc" });
    await writeProjectConfig(h.layer, { taskPrefix: "SUBC" });

    const created = await h.store.createTask({
      description: "archive oscillation fixture",
      title: "Archive oscillation",
      column: "done",
    });

    await h.store.updateTask(created.id, {
      executeRequeueLoopCount: 3,
      executeRequeueLoopSignature: "loop-signature",
    });

    let movedPayload: { task: { deletedAt?: string; executeRequeueLoopCount?: number; executeRequeueLoopSignature?: string }; from: string; to: string } | undefined;
    h.store.on("task:moved", (payload: unknown) => {
      movedPayload = payload as typeof movedPayload;
    });

    const archived = await h.store.archiveTask(created.id);
    expect(archived.column).toBe("archived");

    expect(movedPayload).toBeDefined();
    expect(movedPayload!.from).toBe("done");
    expect(movedPayload!.to).toBe("archived");
    // The emitted payload carries no oscillation state: the scheduler's post-move reset
    // has nothing to attempt against the now soft-deleted row.
    expect(movedPayload!.task.executeRequeueLoopCount).toBeFalsy();
    expect(movedPayload!.task.executeRequeueLoopSignature).toBeFalsy();
    expect(movedPayload!.task.deletedAt).toBeTruthy();

    const rows = await h.adminDb
      .select({
        column: schema.project.tasks.column,
        deletedAt: schema.project.tasks.deletedAt,
        executeRequeueLoopCount: schema.project.tasks.executeRequeueLoopCount,
        executeRequeueLoopSignature: schema.project.tasks.executeRequeueLoopSignature,
      })
      .from(schema.project.tasks)
      .where(and(eq(schema.project.tasks.id, created.id), isNotNull(schema.project.tasks.deletedAt)));
    expect(rows).toHaveLength(1);
    expect(rows[0].column).toBe("archived");
    expect(rows[0].executeRequeueLoopCount).toBeNull();
    expect(rows[0].executeRequeueLoopSignature).toBeNull();
  });
});
