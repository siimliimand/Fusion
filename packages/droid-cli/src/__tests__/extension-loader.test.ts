/**
 * FNXC:PiAiTranscriptResolution 2026-11-04-09:44 (FIX-9):
 * Production regression proof for droid-cli's transcript-helper resolution through the
 * REAL pi extension loader (`@earendil-works/pi-coding-agent`'s jiti instance). Vitest's
 * own resolver handles `@earendil-works/pi-ai/utils/transcript` via the package exports
 * map, so plain vitest imports stayed green while every production agent session failed
 * with `Cannot find module '…/pi-ai/dist/compat.js/utils/transcript'` — the loader's jiti
 * alias table prefix-rewrites the bare `@earendil-works/pi-ai` specifier onto its compat
 * ENTRY FILE and appends the subpath. Only loading through `discoverAndLoadExtensions`
 * reproduces that resolution mode.
 *
 * The positive case loads a temp entry that imports droid-cli's real
 * `src/pi-ai-transcript.ts` and awaits the same init the extension factory performs.
 * The full `index.ts` entry additionally depends on `@fusion-plugin-examples/droid-runtime`,
 * whose `dist` build product is absent in a source-checkout unit-test environment, so
 * loading the whole entry here would fail on that unrelated, build-dependent seam.
 *
 * The broken-subpath fixture is the negative control: if it ever loads cleanly, this
 * suite is no longer exercising the production alias resolution mode and the positive
 * assertion proves nothing.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

// Nonexistent discovery dirs: the loader would otherwise auto-discover real project/
// agent extensions and pollute the assertions. configuredPaths is the sole source here.
const isolatedCwd = join(tmpdir(), "droid-cli-loader-test-nonexistent-cwd");
const isolatedAgentDir = join(tmpdir(), "droid-cli-loader-test-nonexistent-agent");

const helperModulePath = fileURLToPath(new URL("../pi-ai-transcript.ts", import.meta.url));

describe("droid-cli pi-ai transcript resolution through the production pi loader", () => {
  it("loads the real transcript helper module and replays a transcript (jiti alias resolution)", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "droid-cli-loader-probe-"));
    try {
      const entryPath = join(fixtureDir, "transcript-probe.ts");
      writeFileSync(
        entryPath,
        [
          `import { getCurrentSystemPrompt, getCurrentTools, initPiAiTranscriptHelpers } from ${JSON.stringify(pathToFileURL(helperModulePath).href)};`,
          "",
          "export default async function () {",
          "  await initPiAiTranscriptHelpers();",
          '  const tools = getCurrentTools([{ role: "system", content: "probe", tools: [] }]);',
          "  const prompt = getCurrentSystemPrompt([{ role: \"system\", content: \"probe\" }]);",
          "  if (!Array.isArray(tools) || typeof prompt !== \"string\") {",
          '    throw new Error("transcript helpers returned unexpected shapes");',
          "  }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await discoverAndLoadExtensions([entryPath], isolatedCwd, isolatedAgentDir);

      expect(result.errors).toEqual([]);
      expect(result.extensions).toHaveLength(1);
      expect(result.extensions[0].path).toBe(entryPath);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reproduces the incident alias failure for the retired subpath import (negative control)", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "droid-cli-loader-control-"));
    try {
      const fixturePath = join(fixtureDir, "broken-transcript-import.ts");
      writeFileSync(
        fixturePath,
        [
          'import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";',
          "export default function () { void getCurrentSystemPrompt; }",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await discoverAndLoadExtensions([fixturePath], isolatedCwd, isolatedAgentDir);

      expect(result.extensions).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe(fixturePath);
      // The alias-mangled deep path is the exact production symptom: the subpath was
      // appended onto the compat ENTRY FILE because `utils/transcript` is not an alias key.
      expect(result.errors[0].error).toContain("pi-ai/dist/compat.js/utils/transcript");
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 30_000);
});
