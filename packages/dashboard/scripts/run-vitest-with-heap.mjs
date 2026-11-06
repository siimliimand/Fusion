#!/usr/bin/env node
/* global console, process */

/*
FNXC:DashboardVitestHeapWrapper 2026-11-06-11:56:
KB-022: the wrapper historically spawned a NESTED `pnpm exec vitest` — the only
CI lane chain with an extra node-wrapper → nested-pnpm hop (every other lane
invokes vitest directly via its package .bin). The first Full Suite runs showed
the dashboard-lane class failing while single-hop lanes passed, and the nested
hop is the only structurally unique layer in that chain. The default spawn
target is now a DIRECT Node invocation of the dashboard-local vitest entry
(packages/dashboard/node_modules/vitest/vitest.mjs via pathToFileURL), which
removes the hop while preserving the heap NODE_OPTIONS, every forwarded vitest
arg, and the wall-clock watchdog. The FUSION_RUN_VITEST_SPAWN_OVERRIDE test
seam is unchanged. The entry is resolved relative to this script's own
directory (packages/dashboard), not the caller's cwd, so the resolution holds
under any invocation root; a missing entry fails LOUDLY with the install hint
instead of letting a nested process manager produce an opaque exit code.
*/

import { existsSync } from "node:fs";

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runWithWatchdog } from "../../../scripts/lib/run-vitest-watchdog.mjs";

// The dashboard package root is always this script's parent directory
// (packages/dashboard/scripts/..), regardless of the process cwd.
const DASHBOARD_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Split wrapper argv into the heap request and the forwarded vitest args.
 * Exported so the arg contract is unit-testable without spawning processes.
 *
 * @param {string[]} argv raw process.argv
 * @returns {{ heapMb: string, vitestArgs: string[] }}
 */
export function parseWrapperArgs(argv) {
  const rawArgs = argv.slice(2);
  const heapArg = rawArgs.find((arg) => arg.startsWith("--heap="));
  const heapMb = heapArg?.slice("--heap=".length) || "6144";
  const vitestArgs = rawArgs.filter((arg) => !arg.startsWith("--heap="));
  return { heapMb, vitestArgs };
}

/**
 * Build the child env with the heap-capped NODE_OPTIONS. Existing NODE_OPTIONS
 * entries are preserved after the heap flag so a caller-provided Node option
 * survives; Node honors the last --max-old-space-size when duplicated.
 *
 * @param {{ heapMb: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {NodeJS.ProcessEnv}
 */
export function buildNodeEnv({ heapMb, env = process.env }) {
  const nodeOptions = [`--max-old-space-size=${heapMb}`, env.NODE_OPTIONS || ""].join(" ").trim();
  return { ...env, NODE_OPTIONS: nodeOptions };
}

/**
 * Resolve the spawn target for vitest. Default: run the dashboard-local vitest
 * entry directly under this process's Node binary (no nested package-manager
 * hop). FUSION_RUN_VITEST_SPAWN_OVERRIDE (JSON {command, args}) keeps its
 * historical role as the process-lifecycle test seam.
 *
 * @param {{ vitestArgs: string[], env?: NodeJS.ProcessEnv, dashboardRoot?: string }} opts
 * @returns {{ command: string, args: string[] }}
 */
export function resolveSpawnCommand({ vitestArgs, env = process.env, dashboardRoot = DASHBOARD_ROOT }) {
  const override = env.FUSION_RUN_VITEST_SPAWN_OVERRIDE;
  if (!override) {
    const vitestEntry = join(dashboardRoot, "node_modules", "vitest", "vitest.mjs");
    if (!existsSync(vitestEntry)) {
      throw new Error(
        `[dashboard-vitest] vitest entry not found at ${vitestEntry}. ` +
          "Run `pnpm install` in the workspace before invoking dashboard quality lanes.",
      );
    }
    return { command: process.execPath, args: [pathToFileURL(vitestEntry).href, ...vitestArgs] };
  }

  const parsedOverride = JSON.parse(override);
  if (
    !parsedOverride ||
    typeof parsedOverride.command !== "string" ||
    parsedOverride.command.length === 0 ||
    !Array.isArray(parsedOverride.args) ||
    parsedOverride.args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error(
      "FUSION_RUN_VITEST_SPAWN_OVERRIDE must be valid JSON with string command and string[] args",
    );
  }

  // Test seam for process-lifecycle coverage without launching real vitest.
  return { command: parsedOverride.command, args: parsedOverride.args };
}

// Clamp to the default on a missing/malformed value. A bad env value must never
// produce NaN — the watchdog only arms when budgetMs is finite and > 0, so a
// NaN here would silently disable the killer and bring back the very hang this
// wrapper exists to prevent.
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.error(`[dashboard-vitest] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

async function main() {
  const { heapMb, vitestArgs } = parseWrapperArgs(process.argv);

  if (vitestArgs.length === 0) {
    console.error("Usage: node scripts/run-vitest-with-heap.mjs [--heap=6144] <vitest args...>");
    process.exit(1);
  }

  const timeoutMs = positiveIntEnv("FUSION_RUN_VITEST_TIMEOUT_MS", 900000);
  const graceMs = positiveIntEnv("FUSION_RUN_VITEST_KILL_GRACE_MS", 5000);

  let spawnTarget;
  try {
    spawnTarget = resolveSpawnCommand({ vitestArgs });
  } catch (error) {
    // Fail loudly: a missing vitest entry must never masquerade as a test
    // failure downstream.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const label = vitestArgs.join(" ");

  // Dashboard lanes keep their historical fixed budget (default 15min) rather than
  // the timings-derived bands the shard/changed runners use — heap pressure, not
  // duration, is what wedges a lane, so a flat generous budget is correct here.
  const { code, signal, timedOut } = await runWithWatchdog({
    command: spawnTarget.command,
    args: spawnTarget.args,
    env: buildNodeEnv({ heapMb }),
    budgetMs: timeoutMs,
    graceMs,
    label,
    log: console.error,
    spawn,
  });

  if (signal) {
    // Re-raise the child's terminating signal so the wrapper exits the same way.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? (timedOut ? 124 : 1));
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFilePath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
