/**
 * FNXC:PiAiTranscriptResolution 2026-11-04-09:44 (FIX-9):
 * Production regression proof for the extension entry loading through the REAL pi
 * extension loader (`@earendil-works/pi-coding-agent`'s jiti instance). Vitest's own
 * resolver handles `@earendil-works/pi-ai/utils/transcript` via the package exports
 * map, so plain vitest imports of `index.ts` stayed green while every production
 * agent session failed with `Cannot find module '…/pi-ai/dist/compat.js/utils/transcript'`
 * — the loader's jiti alias table prefix-rewrites the bare `@earendil-works/pi-ai`
 * specifier onto its compat ENTRY FILE and appends the subpath. Only loading through
 * `discoverAndLoadExtensions` reproduces that resolution mode.
 *
 * The broken-subpath fixture is the negative control: if it ever loads cleanly, this
 * suite is no longer exercising the production alias resolution mode and the positive
 * assertion proves nothing.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

// Nonexistent discovery dirs: the loader would otherwise auto-discover real project/
// agent extensions and pollute the assertions. configuredPaths is the sole source here.
const isolatedCwd = join(tmpdir(), "pi-claude-cli-loader-test-nonexistent-cwd");
const isolatedAgentDir = join(tmpdir(), "pi-claude-cli-loader-test-nonexistent-agent");

describe("pi-claude-cli extension entry through the production pi loader", () => {
  it("loads index.ts without errors (jiti alias resolution)", async () => {
    const entry = fileURLToPath(new URL("../../index.ts", import.meta.url));
    const result = await discoverAndLoadExtensions([entry], isolatedCwd, isolatedAgentDir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toBe(entry);
  }, 30_000);

  it("reproduces the incident alias failure for the retired subpath import (negative control)", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "pi-claude-cli-loader-control-"));
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
