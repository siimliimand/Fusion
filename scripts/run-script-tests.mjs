#!/usr/bin/env node

import { existsSync, globSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

/*
FNXC:TestInfrastructure 2026-06-21-10:00:
Script-test verification must honor forwarded file arguments so targeted checks stay fast inside Fusion tasks.
The old package script always expanded scripts/__tests__/*.test.mjs before forwarded args, turning `pnpm test:scripts -- scripts/__tests__/x.test.mjs` into the full script suite and making task completion look stalled.

FNXC:TestInfrastructure 2026-11-11-22:28:
Forwarded paths are existence-validated before any child spawns: a path missing on disk fails fast with "[run-script-tests] forwarded path does not exist: <resolved absolute path>" and exit 1, instead of dying later with node's unattributed "Could not find '<abs path>'".
Motivation: KB-038's full-suite sweep was killed mid-run inside the bounded verification window and targeted verification had no documented, tested lane; a mistyped guard path must be diagnosed at the runner level.
Both existing files and existing directories are accepted (plain existence check) because node --test accepts directories; the default no-args glob behavior is unchanged.
*/

const forwarded = process.argv.slice(2).filter((arg) => arg !== "--");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// FNXC:TestInfrastructure 2026-11-11-22:28: fail fast on a nonexistent forwarded path before spawning node --test.
const resolvedForwarded = forwarded.map((file) => resolve(repoRoot, file));
const missingForwarded = resolvedForwarded.find((file) => !existsSync(file));
if (missingForwarded !== undefined) {
  console.error(`[run-script-tests] forwarded path does not exist: ${missingForwarded}`);
  process.exit(1);
}

const testFiles = forwarded.length > 0
  ? resolvedForwarded
  : globSync("scripts/__tests__/*.test.mjs", { cwd: repoRoot }).sort().map((file) => resolve(repoRoot, file));

if (testFiles.length === 0) {
  console.error("[run-script-tests] no script test files matched");
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  cwd: repoRoot,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
