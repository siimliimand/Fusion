// @vitest-environment node
//
// FNXC:BoardContextUsage 2026-11-12-10:59:
// HTTP-level coverage for the additive `contextUsage` enrichment on
// `GET /tasks`. Mirrors the `plannerOverseerState` enrichment contract: attach
// when the engine's live-usage accessor returns a snapshot for the task, omit
// the key entirely (byte-identical payload) otherwise, and never fail the
// board load even when the accessor throws.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import express from "express";
import { TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../../core/src/__test-utils__/pg-test-harness.js";
import type { ProjectEngine } from "@fusion/engine";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

pgDescribe("GET /tasks — contextUsage enrichment", () => {
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    harness = await createTaskStoreForTest();
    store = harness.store;
  });

  afterEach(async () => {
    await harness.teardown();
  });

  function buildApp(engine: Partial<ProjectEngine> | undefined): express.Express {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, engine ? {
      engine: { getProjectId: () => "test-project", ...engine } as unknown as ProjectEngine,
    } : undefined));
    return app;
  }

  it("attaches contextUsage for tasks the engine reports as live", async () => {
    const liveTask = await store.createTask({ description: "running task" });
    const idleTask = await store.createTask({ description: "idle task" });

    const usage = { tokens: 214_000, contextWindow: 1_000_000, percent: 21 };
    const engineStub: Partial<ProjectEngine> = {
      getTaskStore: () => store,
      getLiveTaskContextUsage: () => new Map([[liveTask.id, usage]]),
    };

    const app = buildApp(engineStub);
    const res = await REQUEST(app, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows.find((t) => t.id === liveTask.id)?.contextUsage).toEqual(usage);
    // Idle tasks stay byte-identical: the key is omitted, never null.
    expect(rows.find((t) => t.id === idleTask.id && "contextUsage" in t)).toBeUndefined();
  });

  it("omits contextUsage entirely (no key) when no session is live", async () => {
    const task = await store.createTask({ description: "idle task" });

    const engineStub: Partial<ProjectEngine> = {
      getTaskStore: () => store,
      getLiveTaskContextUsage: () => new Map(),
    };

    const app = buildApp(engineStub);
    const res = await REQUEST(app, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found && "contextUsage" in found).toBe(false);
  });

  it("returns 200 with the un-enriched list when the accessor throws (board load never fails)", async () => {
    const task = await store.createTask({ description: "throwing task" });

    const engineStub: Partial<ProjectEngine> = {
      getTaskStore: () => store,
      getLiveTaskContextUsage: () => {
        throw new Error("boom");
      },
    };

    const app = buildApp(engineStub);
    const res = await REQUEST(app, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found && "contextUsage" in found).toBe(false);
  });

  it("returns 200 with the un-enriched list when no engine is present at all", async () => {
    const task = await store.createTask({ description: "no engine task" });

    const app = buildApp(undefined);
    const res = await REQUEST(app, "GET", "/api/tasks");
    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found && "contextUsage" in found).toBe(false);
  });
});
