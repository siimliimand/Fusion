import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  let settings: Record<string, unknown> = {};
  let latestTui: FakeDashboardTui | undefined;
  let resolveTuiReady: ((tui: FakeDashboardTui) => void) | undefined;
  let tuiReady = new Promise<FakeDashboardTui>((resolve) => { resolveTuiReady = resolve; });
  let resolveTaskStoreBarrier: (() => void) | undefined;
  let taskStoreBarrier: Promise<void> = Promise.resolve();

  class FakeDashboardTui {
    settingsPayloads: Array<Record<string, unknown>> = [];
    callbackPayloads: Array<Record<string, unknown>> = [];
    callbacks: Record<string, unknown> = {};
    interactiveData: Record<string, unknown> = {};
    boardScopedProjectPath: string | null = null;

    constructor() {
      latestTui = this;
      resolveTuiReady?.(this);
    }

    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    setLoadingStatus = vi.fn();
    setSystemInfo = vi.fn();
    setReady = vi.fn();
    setTaskStats = vi.fn();
    setInteractiveData = vi.fn((data: Record<string, unknown>) => { this.interactiveData = data; });
    onBoardScopeChange = vi.fn();
    hydrateVitestKillSettings = vi.fn();
    log = vi.fn();
    setCallbacks = vi.fn((callbacks: Record<string, unknown>) => {
      this.callbackPayloads.push(callbacks);
      this.callbacks = callbacks;
    });
    setSettings = vi.fn((payload: Record<string, unknown>) => { this.settingsPayloads.push(payload); });
  }

  class FakeLogSink {
    setTUI = vi.fn();
    captureConsole = vi.fn();
    log = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    getRecentEntries = vi.fn(() => []);
  }

  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const emitStoreEvent = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const store: Record<string, any> = {
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return store;
    },
    listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
  };
  Object.assign(store, {
    init: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    getAsyncLayer: vi.fn(() => ({})),
    getFusionDir: vi.fn(() => "/repo/.fusion"),
    getRootDir: vi.fn(() => "/repo"),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => {
      settings = { ...settings, ...patch };
    }),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn(async () => ({})), updateSettings: vi.fn(async () => undefined) })),
    getPluginStore: vi.fn(() => ({ init: vi.fn(async () => undefined) })),
    healthCheck: vi.fn(async () => ({ ok: true })),
    isBackendMode: vi.fn(() => false),
    listTasks: vi.fn(async () => []),
  });

  const appListeners = new Map<string, Array<(...args: any[]) => void>>();
  const app: Record<string, any> = {
    on: (event: string, listener: (...args: any[]) => void) => {
      appListeners.set(event, [...(appListeners.get(event) ?? []), listener]);
      return app;
    },
  };
  Object.assign(app, {
    listen: vi.fn(() => {
      queueMicrotask(() => appListeners.get("listening")?.forEach((listener) => listener()));
      return app;
    }),
    address: vi.fn(() => ({ port: 0 })),
    close: vi.fn(),
  });

  return {
    FakeDashboardTui,
    FakeLogSink,
    app,
    store,
    getSettings: () => settings,
    latestTui: () => latestTui,
    waitForTui: () => tuiReady,
    emitStoreEvent,
    holdTaskStore: () => {
      taskStoreBarrier = new Promise<void>((resolve) => { resolveTaskStoreBarrier = resolve; });
    },
    releaseTaskStore: () => resolveTaskStoreBarrier?.(),
    createTaskStore: async () => {
      await taskStoreBarrier;
      return { taskStore: store, shutdown: vi.fn(async () => undefined) };
    },
    setSettings: (next: Record<string, unknown>) => { settings = next; },
    reset: () => {
      resolveTaskStoreBarrier?.();
      settings = {};
      latestTui = undefined;
      resolveTuiReady = undefined;
      tuiReady = new Promise<FakeDashboardTui>((resolve) => { resolveTuiReady = resolve; });
      taskStoreBarrier = Promise.resolve();
      resolveTaskStoreBarrier = undefined;
      vi.clearAllMocks();
    },
  };
});

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  class NoopStore {
    init = vi.fn(async () => undefined);
    on = vi.fn();
    close = vi.fn(async () => undefined);
  }
  return {
    ...actual,
    createTaskStoreForBackend: vi.fn(() => harness.createTaskStore()),
    AutomationStore: NoopStore,
    AgentStore: class extends NoopStore { listAgents = vi.fn(async () => []); },
    PluginLoader: class { loadAllPlugins = vi.fn(async () => ({ loaded: 0, errors: 0 })); getPluginSkills = vi.fn(() => []); },
    MissionStore: NoopStore,
    CentralCore: class {
      init = vi.fn(async () => undefined);
      listProjects = vi.fn(async () => []);
      listNodes = vi.fn(async () => []);
    },
    setHostTaskStore: vi.fn(),
    setDiagnosticDbHealthCheck: vi.fn(),
    setDiagnosticStoreListenerCheck: vi.fn(),
  };
});

vi.mock("@fusion/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/dashboard")>()),
  createServer: vi.fn(() => harness.app),
  refreshAllCustomProviderModels: vi.fn(async () => ({ refreshed: 0, failed: 0, skipped: 0 })),
  stopAllDevServers: vi.fn(async () => undefined),
}));

vi.mock("../dashboard-tui/index.js", () => ({
  DashboardTUI: harness.FakeDashboardTui,
  DashboardLogSink: harness.FakeLogSink,
  isTTYAvailable: vi.fn(() => true),
}));

vi.mock("../dashboard-startup-chain.js", () => ({
  DASHBOARD_STARTUP_STATUS: {
    initializingTaskStore: "Initializing task store…",
    initializingAgentStore: "Initializing agent store…",
    startingAgents: "Starting agents…",
    loadingExtensions: "Loading extensions…",
    startingEngine: "Starting engine…",
  },
  runTuiStartupPrelude: vi.fn(async (tui: { start: () => Promise<void>; setLoadingStatus: (status: string) => void }) => {
    await tui.start();
    tui.setLoadingStatus("Initializing task store…");
  }),
}));

/*
FNXC:DashboardSettingsSeams 2026-11-11-15:39:
Every runDashboard dispatch performs real-I/O demands inside the default 5000 ms vitest
testTimeout, measured per-phase on 2026-11-11 with the suite's own FakeLogSink phase records
(dispatch 1 focused: 3424ms total — well inside budget only on an idle machine; under the
loaded changed-only lane, CPU starvation across concurrently running package lanes pushed it
past 5s twice, register entry 24: KB-003 tree 587c9ef69, KB-013 tree f1eefaad37):

1. discoverAndLoadExtensions: 3140ms on the FIRST dispatch — the pi extension runtime loads
   real extension modules (the self-extension's whole module graph compiles inside the timed
   window); the ESM cache makes dispatches 2–4 ~37ms, so only the suite's first test carries
   the cost. Seamed to an empty deterministic result.
2. The startup update-check read races isUpdateCheckEnabled() against a 3-second setTimeout
   that runDashboard awaits before completing; isUpdateCheckEnabled constructs a real
   GlobalSettingsStore (not covered by the @fusion/core mock, which replaces CentralCore but
   passes GlobalSettingsStore through). Seamed to resolve false so the race returns null
   immediately.
3. resolveRuntimeProjectPath awaits a real resolveProject (CentralCore/default-project read
   plus a detectProjectFromCwd filesystem walk). Seamed to return the harness's fake root
   ("/repo") so its sole consumed field (.projectPath) stays consistent with the fake store's
   getRootDir().

These suite-local seams keep the timed window deterministic without touching any assertion.
No production behavior is asserted through any seam; the suite's contract remains the
callback-level live-settings mapping (FNXC:CapacityModel).
*/
vi.mock("../../update-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../update-cache.js")>()),
  isUpdateCheckEnabled: vi.fn(async () => false),
}));

vi.mock("../../project-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../project-context.js")>()),
  resolveProject: vi.fn(async () => ({ projectPath: "/repo" })),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  // Only consumed fields in the dashboard startup path: errors (logged) and
  // runtime.pendingProviderRegistrations (iterated, then reassigned to []).
  discoverAndLoadExtensions: vi.fn(async () => ({
    errors: [],
    runtime: { pendingProviderRegistrations: [] },
  })),
}));

const { DEFAULT_PROJECT_SETTINGS, resolveEffectiveConcurrency, resolveWorktreeCapacityLimit } = await import("@fusion/core");
const { runDashboard } = await import("../dashboard.js");

type SettingsCallbacks = {
  onTogglePause: (paused: boolean) => Promise<Record<string, unknown>>;
  getSettings: () => Promise<Record<string, unknown>>;
};

function getSettingsCallbacks(tui: InstanceType<typeof harness.FakeDashboardTui>): SettingsCallbacks {
  const pauseCallbacks = tui.callbackPayloads.find((callbacks) => "onTogglePause" in callbacks);
  return {
    onTogglePause: pauseCallbacks?.onTogglePause as SettingsCallbacks["onTogglePause"],
    getSettings: tui.interactiveData.getSettings as SettingsCallbacks["getSettings"],
  };
}

function expectedConcurrency(settings: Record<string, unknown>): Pick<Record<string, unknown>, "maxConcurrent" | "maxWorktrees"> {
  const capacity = resolveEffectiveConcurrency(settings);
  return {
    maxConcurrent: capacity.maxConcurrent,
    maxWorktrees: resolveWorktreeCapacityLimit({ ...settings, worktreeLimitEnabled: true }),
  };
}

/**
 * FNXC:CapacityModel 2026-08-21-23:57:
 * Callback-level coverage is required because a correct mapping helper cannot detect a
 * runDashboard callback that stops reading live settings and reintroduces private defaults.
 */
describe("dashboard TUI concurrency settings", () => {
  beforeEach(() => harness.reset());

  it.each([
    ["unset", {}],
    ["configured", { maxConcurrent: 6, maxWorktrees: 9 }],
    ["worktree-bound", { maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true }],
  ] as const)("drives %s live settings through every runDashboard TUI callback", async (_state, settings) => {
    harness.setSettings(settings);
    const expected = expectedConcurrency(settings);

    await runDashboard(0, { noEngine: true, noAuth: true });
    await new Promise((resolve) => setImmediate(resolve));

    const tui = harness.latestTui();
    expect(tui).toBeDefined();
    expect(tui?.setSettings).toHaveBeenCalledWith(expect.objectContaining(expected));

    const callbacks = getSettingsCallbacks(tui!);
    await expect(callbacks.onTogglePause(true)).resolves.toEqual(expect.objectContaining(expected));
    await expect(callbacks.getSettings()).resolves.toEqual(expect.objectContaining(expected));

    tui!.setSettings.mockClear();
    harness.emitStoreEvent("settings:updated", { settings, previous: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(tui!.setSettings).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it("uses DEFAULT_PROJECT_SETTINGS when onTogglePause runs before a store exists", async () => {
    harness.holdTaskStore();
    const dashboard = runDashboard(0, { noEngine: true, noAuth: true });
    const tui = await harness.waitForTui();

    await expect(getSettingsCallbacks(tui).onTogglePause(true)).resolves.toEqual(expect.objectContaining({
      maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      maxWorktrees: DEFAULT_PROJECT_SETTINGS.maxWorktrees,
    }));
    harness.releaseTaskStore();
    await dashboard;
  });
});
