import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type QuarantineEntry = {
  file: string;
  reason: string;
  quarantinedAt: string;
};

const repoRoot = resolve(import.meta.dirname!, "../../../..");
const configPath = resolve(repoRoot, "packages/cli/vitest.config.ts");
const ledgerPath = resolve(repoRoot, "scripts/lib/test-quarantine.json");
const cliPathPrefix = "packages/cli/";
const iso8601Timestamp = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function parseQuarantinedCliTests(configSource: string): string[] {
  const declaration = configSource.match(/const quarantinedCliTests: string\[\] = \[([\s\S]*?)\n\];/);
  expect(declaration, "quarantinedCliTests declaration must remain statically parseable").not.toBeNull();

  return [...declaration![1].matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

function countByPath(paths: string[]): Map<string, number> {
  return paths.reduce((counts, path) => counts.set(path, (counts.get(path) ?? 0) + 1), new Map<string, number>());
}

function normalizeConfigPath(path: string): string {
  return `${cliPathPrefix}${path}`;
}

describe("CLI quarantine ledger lockstep", () => {
  /*
  FNXC:CliTests 2026-07-17-10:45:
  FN-8223 widens this guard to the full CLI quarantine surface after FN-8219
  deleted its five expired paths and FN-8210 rescued package-config.test.ts.
  Every package-relative Vitest exclude and repo-relative packages/cli ledger
  row must now match exactly once, preventing future one-sided quarantine drift.
  */
  it("keeps all CLI config excludes and ledger rows in bidirectional lockstep", () => {
    const configPaths = parseQuarantinedCliTests(readFileSync(configPath, "utf8")).map(normalizeConfigPath);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { entries: QuarantineEntry[] };
    const ledgerEntries = ledger.entries.filter((entry) => entry.file.startsWith(cliPathPrefix));
    const ledgerPaths = ledgerEntries.map((entry) => entry.file);
    const configCounts = countByPath(configPaths);
    const ledgerCounts = countByPath(ledgerPaths);

    for (const count of configCounts.values()) {
      expect(count).toBe(1);
    }
    for (const count of ledgerCounts.values()) {
      expect(count).toBe(1);
    }
    expect(configCounts).toEqual(ledgerCounts);

    for (const entry of ledgerEntries) {
      expect(entry.reason.trim()).not.toBe("");
      expect(entry.quarantinedAt).toMatch(iso8601Timestamp);
      expect(Number.isNaN(Date.parse(entry.quarantinedAt))).toBe(false);
    }
  });

  it("keeps skills-get rescued and absent from both CLI quarantine surfaces", () => {
    /*
    FNXC:CliTests 2026-11-11-23:05 (KB-037):
    KB-037 rescues the FN-9425 skills-get quarantine before its 2026-10-13 deletion deadline.
    Root cause: the failing test held three sequential built-CLI process lifecycles inside one
    default-5000ms body, so loaded shards pushed it past the budget; the structural split gives
    each built request its own single-spawn test with byte-identical assertions. The quarantine
    pair (this list's entry and the ledger row) was removed in lockstep with the split. This pin
    asserts the concrete new truth — full absence from BOTH surfaces — so any re-quarantine of
    this file must consciously reconcile this test, not silently re-add the pair.
    */
    const quarantinedFile = "src/commands/__tests__/skills-get.test.ts";
    const configPaths = parseQuarantinedCliTests(readFileSync(configPath, "utf8"));
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { entries: QuarantineEntry[] };
    const entries = ledger.entries.filter((entry) => entry.file === `${cliPathPrefix}${quarantinedFile}`);

    expect(configPaths.filter((path) => path === quarantinedFile)).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });
});
