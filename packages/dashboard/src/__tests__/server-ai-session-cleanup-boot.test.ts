/*
FNXC:MemoryWedge 2026-11-06-13:30:
KB-010 (FIX-13) accumulator fix: the AiSessionStore scheduled cleanup
(startScheduledCleanup) existed but was never invoked by any production boot
path — ai_sessions only shrank via the manual DELETE /api/ai-sessions/cleanup
endpoint, so terminal and orphaned sessions accumulated until the process
wedged (2026-11-05 incident). These tests pin the boot contract:

1. createServer starts the scheduled cleanup on the injected aiSessionStore
   with the project cadence (SESSION_CLEANUP_INTERVAL_MS = 6h) and the
   7-day TTL default (SESSION_CLEANUP_DEFAULT_MAX_AGE_MS).
2. The started cleanup is PAIRED: the server "close" handler stops it, so no
   timer outlives the server across restarts or test teardowns.

The mock store fixture is adapted from server-task-archive-stash-sync.test.ts
(the methods createServer boot needs); the aiSessionStore double spies the
cleanup lifecycle without touching PostgreSQL.
*/
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { createServer } from "../server.js";
import { SESSION_CLEANUP_DEFAULT_MAX_AGE_MS, SESSION_CLEANUP_INTERVAL_MS } from "../ai-session-store.js";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    // Mirror server-task-archive-stash-sync.test.ts: stub the constructors
    // createServer may touch at boot so the fixture never constructs real
    // mesh/agent stores.
    CentralCore: vi.fn().mockImplementation(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        mergePeers: vi.fn().mockResolvedValue({ added: [], updated: [] }),
        getAllKnownPeerInfo: vi.fn().mockResolvedValue([]),
        getLocalPeerInfo: vi.fn(),
        getNode: vi.fn(),
        updateNode: vi.fn(),
        getLocalNode: vi.fn(),
        listNodes: vi.fn(),
        getLocalMeshSnapshot: vi.fn(),
        getSettingsForSync: vi.fn(),
        applyRemoteSettings: vi.fn(),
        applyAuthMaterialSnapshot: vi.fn(),
        getAuthMaterialSnapshot: vi.fn(),
      };
    }),
    AgentStore: vi.fn().mockImplementation(function () {
      return {
        init: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        getAgentSnapshot: vi.fn(() => undefined),
        getAgentRunSnapshot: vi.fn(() => undefined),
        applyAgentSnapshot: vi.fn(async () => undefined),
        applyAgentRunSnapshot: vi.fn(async () => undefined),
      };
    }),
  };
});

class MockStore extends EventEmitter {
  getAsyncLayer(): { projectId: string } {
    return { projectId: "kb-010-cleanup-boot-test" };
  }

  get backendMode(): boolean {
    return true;
  }

  getRootDir(): string {
    return "/tmp/fn-kb-010-cleanup-boot";
  }

  getFusionDir(): string {
    return "/tmp/fn-kb-010-cleanup-boot/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    };
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  getGlobalSettingsStore() {
    return { getSettings: vi.fn().mockResolvedValue({}) };
  }

  getDistributedTaskIdAllocator() {
    return {
      reserveDistributedTaskId: vi.fn(),
      commitDistributedTaskIdReservation: vi.fn(),
      abortDistributedTaskIdReservation: vi.fn(),
      getDistributedTaskIdState: vi.fn(),
    };
  }

  async applyReplicatedTaskCreate(_payload: unknown): Promise<{ task: Task; applied: boolean }> {
    return { task: {} as Task, applied: false };
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }

  async getSettings(): Promise<Record<string, unknown>> {
    return {};
  }
}

interface CleanupLifecycleSpies {
  startScheduledCleanup: ReturnType<typeof vi.fn>;
  stopScheduledCleanup: ReturnType<typeof vi.fn>;
  cleanupStaleSessions: ReturnType<typeof vi.fn>;
}

function bootServerWithCleanupSpies(): { spies: CleanupLifecycleSpies; listen: () => Promise<{ close: () => Promise<void> }> } {
  const store = new MockStore();
  const chatStore = Object.assign(new EventEmitter(), {
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSessionsForAgentId: vi.fn().mockResolvedValue(0),
  });
  const spies: CleanupLifecycleSpies = {
    startScheduledCleanup: vi.fn(),
    stopScheduledCleanup: vi.fn(),
    cleanupStaleSessions: vi.fn().mockResolvedValue({ terminalDeleted: 0, orphanedDeleted: 0 }),
  };
  const aiSessionStore = Object.assign(new EventEmitter(), {
    recoverStaleSessions: vi.fn().mockResolvedValue(0),
    rehydrateFromStore: vi.fn().mockResolvedValue(0),
    listRecoverable: vi.fn().mockResolvedValue([]),
    ...spies,
  });
  const app = createServer(store as never, {
    chatStore: chatStore as never,
    aiSessionStore: aiSessionStore as never,
  });
  const listen = async () => {
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    return {
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
  };
  return { spies, listen };
}

describe("server boot starts the AI-session scheduled cleanup (KB-010)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the cleanup at boot with the 6h cadence and the 7-day TTL default", () => {
    const { spies } = bootServerWithCleanupSpies();
    expect(spies.startScheduledCleanup).toHaveBeenCalledTimes(1);
    expect(spies.startScheduledCleanup).toHaveBeenCalledWith(
      SESSION_CLEANUP_INTERVAL_MS,
      SESSION_CLEANUP_DEFAULT_MAX_AGE_MS,
    );
    expect(SESSION_CLEANUP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(SESSION_CLEANUP_DEFAULT_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("stops the scheduled cleanup when the server closes (paired lifecycle)", async () => {
    const { spies, listen } = bootServerWithCleanupSpies();
    const server = await listen();
    expect(spies.stopScheduledCleanup).not.toHaveBeenCalled();
    await server.close();
    expect(spies.stopScheduledCleanup).toHaveBeenCalledTimes(1);
  });
});
