/*
FNXC:RulesetPrLanding 2026-11-04-09:42:
Behavioral coverage for FIX-6 — the ruleset-aware PR landing fallback in the merger.

Original symptom (SUBC-013): a GitHub ruleset (required `test` check, on refs/heads/main) declined
every direct landing push with `! [remote rejected] main -> main (push declined due to repository
rule violations)`. The landing contract classified that as a non-fatal push failure: the merge was
recorded as landed locally while origin stayed behind forever (transient-retry/divergence machinery
could never deliver a push the remote refuses at the ref level).

Exact reproduction: init a repo with a bare `origin` whose pre-receive hook declines
`refs/heads/main` with the ruleset wording while allowing every other ref, enable
`pushAfterMerge`, run `runAiMerge` end-to-end with mock agents, and a fake `gh` that performs the
squash-merge a real GitHub PR merge would perform on the remote.

Assertion it is gone: the landing completes through the PR path — the task branch carries the
landing commit, the PR is created/checked/squash-merged, local main is synced to the post-merge
tip, and mergeDetails.commitSha points at the reachable origin/main commit (the new squash sha) —
across the enumerated surfaces: fast path, divergence path, checks-timeout honest park, and the
unchanged contracts (direct push OK, non-rule push failure).
*/
import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const createResolvedAgentSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-session-helpers.js")>();
  return {
    ...actual,
    createResolvedAgentSession: createResolvedAgentSessionMock,
  };
});
vi.mock("../pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi.js")>();
  return {
    ...actual,
    promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<void> | void }, prompt: string) => {
      await session.prompt(prompt);
    }),
  };
});

import { runAiMerge } from "../merge/merger-ai.js";
import { isRulesetPushRejection, GhCommandError, __test__ as rulesetPrLandingTestHooks, RULESET_PR_CHECKS_POLL_INTERVAL_MS, RULESET_PR_CHECKS_TIMEOUT_MS } from "../merge/ruleset-pr-landing.js";

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const tracked = new Set<string>();
const originalPath = process.env.PATH;
afterAll(() => {
  for (const d of tracked) {
    try { rmSync(d, RM); } catch { /* best effort */ }
  }
  process.env.PATH = originalPath;
});
afterEach(() => {
  rulesetPrLandingTestHooks.setDeps(null);
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();
}

/**
 * A repo on `main` with a bare `origin` remote (main pushed) + a task branch. When
 * `opts.rulesetOnMain` is set, a pre-receive hook declines every `refs/heads/main` update with the
 * exact ruleset wording while allowing all other refs — the ref-level behavior of the incident.
 */
/**
 * Install the ruleset stub AFTER any setup pushes that must reach `refs/heads/main`: the hook
 * declines every `refs/heads/main` update with the exact incident wording while allowing all
 * other refs — the ref-level behavior of the incident ruleset.
 */
function installRulesetHook(originDir: string): void {
  writeFileSync(join(originDir, "hooks", "pre-receive"), `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2
    echo "remote: error: - push declined due to repository rule violations" >&2
    echo "! [remote rejected] main -> main (push declined due to repository rule violations)" >&2
    echo "error: failed to push some refs to 'origin'" >&2
    exit 1
  fi
done
exit 0
`, { mode: 0o755 });
}

function initRepoWithRemote(opts: { branch?: string; rulesetOnMain?: boolean } = {}): { dir: string; originDir: string } {
  const branch = opts.branch ?? "fusion/fn-1";
  const root = mkdtempSync(join(tmpdir(), "fusion-ruleset-pr-landing-test-"));
  tracked.add(root);
  const originDir = join(root, "origin.git");
  const dir = join(root, "work");
  execSync(`git init -q --bare "${originDir}"`, { encoding: "utf-8" });
  execSync(`git init -q -b main "${dir}"`, { encoding: "utf-8" });
  git(dir, "config user.email t@t.t");
  git(dir, "config user.name t");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add -A");
  git(dir, "commit -q -m base");
  git(dir, `remote add origin "${originDir}"`);
  git(dir, "push -q origin main");

  git(dir, `checkout -q -b ${branch}`);
  writeFileSync(join(dir, "feature.txt"), "feature work\n");
  git(dir, "add -A");
  git(dir, "commit -q -m 'feat: work'");
  git(dir, "checkout -q main");

  if (opts.rulesetOnMain) {
    installRulesetHook(originDir);
  }
  return { dir, originDir };
}

/** Commit to origin/main via a second clone (simulates the remote moving ahead). */
function advanceOrigin(originDir: string, fileName: string): void {
  const clone = mkdtempSync(join(tmpdir(), "fusion-ruleset-pr-other-"));
  tracked.add(clone);
  execSync(`git clone -q "${originDir}" "${clone}"`, { encoding: "utf-8" });
  git(clone, "config user.email o@o.o");
  git(clone, "config user.name o");
  writeFileSync(join(clone, fileName), "remote side\n");
  git(clone, "add -A");
  git(clone, `commit -q -m 'remote: ${fileName}'`);
  git(clone, "push -q origin main");
}

function makeStore(settingsOverrides: Record<string, unknown> = {}) {
  const task: Record<string, unknown> = {
    enabledWorkflowSteps: [],
    id: "FN-1",
    column: "in-review",
    status: null,
    branch: "fusion/fn-1",
    worktree: null,
    title: "do the thing",
    steps: [],
  };
  const logs: Array<{ message: string; action?: string }> = [];
  const store = {
    getTask: vi.fn(async () => task),
    getStaleReviewCallbackWaiverReceipts: vi.fn().mockResolvedValue([]),
    getProjectId: vi.fn().mockReturnValue("test-project"),
    getSettings: vi.fn(async () => ({
      merger: { mode: "ai", maxReviewPasses: 1 },
      pushAfterMerge: true,
      ...settingsOverrides,
    })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: typeof task) => Record<string, unknown> | undefined) => {
      const patch = await updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    moveTaskIf: vi.fn(async (_id: string, column: string, predicate: (live: typeof task) => boolean | Promise<boolean>, options?: unknown) => {
      if (!await predicate(task)) return { moved: false, task };
      return { moved: true, task: await store.moveTask(_id, column, options) };
    }),
    emit: vi.fn(),
    logEntry: vi.fn(async (_id: string, message: string, action?: string) => { logs.push({ message, action }); }),
    appendAgentLog: vi.fn(async (_id: string, message: string) => { logs.push({ message }); }),
    emitUsageEvent: vi.fn(async () => true),
    getBranchGroup: vi.fn(() => null),
    recordRunAuditEvent: vi.fn(),
  };
  return { store: store as never, storeMocks: store, task, logs };
}

function realMergeAgent(branch: string) {
  return vi.fn(async (cwd: string) => {
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

const approveReviewer = () => vi.fn(async () => "REVIEW_VERDICT: approve");

/**
 * A fake `gh` binary on PATH. `pr create` records the PR; `pr checks` is green;
 * `pr merge --squash` performs the squash-merge a real GitHub merge performs on the remote:
 * a new commit on refs/heads/main whose tree equals the PR head tree (CAS against the old tip).
 * Every invocation is appended to a log file tests can assert against.
 */
function installFakeGh(mode: "squash" | "fail-hard" = "squash"): { binDir: string; logFile: string; stateFile: string } {
  const binDir = mkdtempSync(join(tmpdir(), "fusion-ruleset-pr-gh-bin-"));
  tracked.add(binDir);
  const logFile = join(binDir, "gh-calls.log");
  const stateFile = join(binDir, "gh-pr-state.txt");
  const script = mode === "fail-hard"
    ? `#!/bin/sh
echo "gh $*" >> "${logFile}"
exit 1
`
    : `#!/bin/sh
echo "gh $*" >> "${logFile}"
cmd="$1"; sub="$2"; shift 2
if [ "$cmd" != "pr" ]; then exit 1; fi
case "$sub" in
  create)
    base=""; head=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --base) base="$2"; shift 2;;
        --head) head="$2"; shift 2;;
        *) shift;;
      esac
    done
    printf 'base=%s\\nhead=%s\\npr_url=https://gh.example.test/repo/pull/42\\n' "$base" "$head" > "${stateFile}"
    echo "https://gh.example.test/repo/pull/42"
    exit 0;;
  checks)
    exit 0;;
  merge)
    subject=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --subject) subject="$2"; shift 2;;
        *) shift;;
      esac
    done
    head_branch="$(sed -n 's/^head=//p' "${stateFile}")"
    origin_url="$(git remote get-url origin)"
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t
    head_sha="$(git -C "$origin_url" rev-parse "refs/heads/$head_branch")"
    tree="$(git -C "$origin_url" rev-parse "$head_sha^{tree}")"
    parent="$(git -C "$origin_url" rev-parse refs/heads/main)"
    new="$(git -C "$origin_url" commit-tree "$tree" -p "$parent" -m "$subject")"
    git -C "$origin_url" update-ref refs/heads/main "$new" "$parent" || exit 1
    exit 0;;
  *)
    exit 1;;
esac
`;
  writeFileSync(join(binDir, "gh"), script, { mode: 0o755 });
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  return { binDir, logFile, stateFile };
}

describe("isRulesetPushRejection (feature detection)", () => {
  it("matches the exact incident rejection and the GH006 protected-branch variant", () => {
    expect(isRulesetPushRejection("! [remote rejected] main -> main (push declined due to repository rule violations)\nerror: failed to push some refs to 'github.com:o/r'")).toBe(true);
    expect(isRulesetPushRejection("remote: error: GH006: Protected branch update failed for refs/heads/main.\n! [remote rejected] main -> main (protected branch hook declined)")).toBe(true);
  });

  it("does not match plain hook declines, diverged pushes, or transient transport failures", () => {
    expect(isRulesetPushRejection("! [remote rejected] main -> main (pre-receive hook declined)")).toBe(false);
    expect(isRulesetPushRejection("! [rejected] main -> main (fetch first)\nerror: failed to push some refs")).toBe(false);
    expect(isRulesetPushRejection("fatal: unable to access: Connection reset by peer")).toBe(false);
    expect(isRulesetPushRejection("")).toBe(false);
  });
});

describe("runAiMerge ruleset-aware PR landing fallback", () => {
  it("delivers a ruleset-declined landing through the PR path and reconciles the bookkeeping (symptom verification)", async () => {
    const { dir, originDir } = initRepoWithRemote({ rulesetOnMain: true });
    const fakeGh = installFakeGh();
    const { store, storeMocks, task, logs } = makeStore();
    const originMainBefore = git(originDir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    const originMain = git(originDir, "rev-parse main");
    // Before the fix the push was declined and origin stayed at base forever.
    expect(originMain).not.toBe(originMainBefore);
    // The PR flow delivered the landing: origin/main == local main == recorded commit sha.
    expect(result.pushedToRemote).toBe(true);
    expect(result.pushError).toBeUndefined();
    expect(git(dir, "rev-parse main")).toBe(originMain);
    expect((task.mergeDetails as { commitSha?: string }).commitSha).toBe(originMain);
    expect((task.mergeDetails as { prNumber?: number }).prNumber).toBe(42);
    expect((task.mergeDetails as { prLanding?: { state?: string } }).prLanding?.state).toBe("landed");
    expect(task.column).toBe("done");
    // The PR head (task branch on the remote) carries exactly the landing tree the squash merged.
    expect(git(originDir, "rev-parse refs/heads/fusion/fn-1^{tree}")).toBe(git(originDir, "rev-parse main^{tree}"));
    // gh was driven through create → checks → squash-merge.
    const ghCalls = readFileSync(fakeGh.logFile, "utf-8");
    expect(ghCalls).toContain("pr create --base main --head fusion/fn-1");
    expect(ghCalls).toContain("pr checks https://gh.example.test/repo/pull/42");
    expect(ghCalls).toContain("pr merge https://gh.example.test/repo/pull/42 --squash");
    // Audits: exactly one bounded ruleset-declined row + a successful push:origin row.
    const audits = storeMocks.recordRunAuditEvent.mock.calls.map(([event]) => event as { mutationType: string; metadata?: Record<string, unknown> });
    const rulesetRows = audits.filter((event) => event.mutationType === "push:ruleset-declined");
    expect(rulesetRows).toHaveLength(1);
    expect(rulesetRows[0]).toEqual(expect.objectContaining({
      mutationType: "push:ruleset-declined",
      metadata: expect.objectContaining({ taskId: "FN-1", remote: "origin", branch: "main", outcome: "pr-fallback-engaged" }),
    }));
    const pushOriginRows = audits.filter((event) => event.mutationType === "push:origin");
    expect(pushOriginRows).toHaveLength(1);
    expect(pushOriginRows[0]).toEqual(expect.objectContaining({
      mutationType: "push:origin",
      metadata: expect.objectContaining({ outcome: "success", landedVia: "pr-ruleset-fallback" }),
    }));
    expect(logs.some((l) => l.action === "RulesetPrLanding" && l.message.includes("PR landing fallback merged"))).toBe(true);
  });

  it("leaves a direct-push landing unchanged (no gh involvement, no ruleset audit)", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const fakeGh = installFakeGh("fail-hard");
    const { store, storeMocks } = makeStore();

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.pushedToRemote).toBe(true);
    expect(git(originDir, "rev-parse main")).toBe(git(dir, "rev-parse main"));
    expect(existsSync(fakeGh.logFile)).toBe(false);
    expect(storeMocks.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: "push:ruleset-declined" }));
  });

  it("parks honest-blocked with the exact marker when required checks do not report within the bounded wait", async () => {
    const { dir, originDir } = initRepoWithRemote({ rulesetOnMain: true });
    const originMainBefore = git(originDir, "rev-parse main");
    const { store, storeMocks, task } = makeStore();
    const gh = vi.fn(async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "create") return "https://gh.example.test/repo/pull/7";
      if (args[0] === "pr" && args[1] === "checks") throw new GhCommandError(args, 8, "some checks are pending", "command failed: gh pr checks");
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    let fakeClock = 0;
    rulesetPrLandingTestHooks.setDeps({
      gh: (args) => gh(args),
      sleep: () => Promise.resolve(),
      now: () => {
        fakeClock += RULESET_PR_CHECKS_POLL_INTERVAL_MS;
        return fakeClock;
      },
    });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    const marker = "PR CHECKS PENDING: https://gh.example.test/repo/pull/7";
    expect(result.pushedToRemote).toBe(false);
    expect(result.pushError).toBe(marker);
    expect(gh.mock.calls.some(([args]) => args[0] === "pr" && args[1] === "create")).toBe(true);
    expect(gh.mock.calls.some(([args]) => args[0] === "pr" && args[1] === "merge")).toBe(false);
    // The bounded wait really terminated at the cap (fake clock advanced past the deadline).
    expect(fakeClock).toBeGreaterThanOrEqual(RULESET_PR_CHECKS_TIMEOUT_MS);
    // Honest park: exact marker on the task, durable checks-pending state, no fabricated delivery.
    expect(task.error).toBe(marker);
    expect((task.mergeDetails as { prLanding?: { state?: string; prUrl?: string } }).prLanding?.state).toBe("checks-pending");
    expect((task.mergeDetails as { prLanding?: { prUrl?: string } }).prLanding?.prUrl).toBe("https://gh.example.test/repo/pull/7");
    expect((task.mergeDetails as { commitSha?: string }).commitSha).toBeTruthy();
    // Lifecycle containment: no automatic backward move out of the terminal column.
    expect(task.column).toBe("done");
    // The remote was never modified beyond the PR head push.
    expect(git(originDir, "rev-parse main")).toBe(originMainBefore);
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:ruleset-declined",
      metadata: expect.objectContaining({ outcome: "pr-fallback-engaged" }),
    }));
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:origin",
      metadata: expect.objectContaining({ outcome: "failed", reason: "pr-checks-pending" }),
    }));
  });

  it("keeps the existing non-fatal failure path for a non-rule push decline (no PR, no fallback audit)", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const fakeGh = installFakeGh("fail-hard");
    // Plain pre-receive decline without rule wording: not a ruleset signature.
    writeFileSync(join(originDir, "hooks", "pre-receive"), `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    echo "! [remote rejected] main -> main (pre-receive hook declined)" >&2
    echo "error: failed to push some refs to 'origin'" >&2
    exit 1
  fi
done
exit 0
`, { mode: 0o755 });
    const originMainBefore = git(originDir, "rev-parse main");
    const { store, storeMocks, logs } = makeStore();

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.pushedToRemote).toBe(false);
    expect(result.pushError).toContain("failed to push some refs");
    expect(existsSync(fakeGh.logFile)).toBe(false);
    expect(git(originDir, "rev-parse main")).toBe(originMainBefore);
    expect(storeMocks.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ mutationType: "push:ruleset-declined" }));
    expect(logs.some((l) => l.action === "PushToRemoteFailed")).toBe(true);
  });

  it("stops honestly when required checks fail instead of waiting out the cap", async () => {
    const { dir, originDir } = initRepoWithRemote({ rulesetOnMain: true });
    const originMainBefore = git(originDir, "rev-parse main");
    const { store, task, logs } = makeStore();
    rulesetPrLandingTestHooks.setDeps({
      gh: async (args) => {
        if (args[0] === "pr" && args[1] === "create") return "https://gh.example.test/repo/pull/11";
        if (args[0] === "pr" && args[1] === "checks") throw new GhCommandError(args, 1, "test: failing", "command failed: gh pr checks");
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
    });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    // The fallback stopped before the squash-merge; the wiring keeps the ORIGINAL ruleset
    // rejection as the push outcome (the checks failure is recorded on the task log instead).
    expect(result.pushedToRemote).toBe(false);
    expect(result.pushError).toContain("failed to push some refs");
    expect(logs.some((l) => l.action === "RulesetPrLandingFailed" && l.message.includes("required checks failed"))).toBe(true);
    // A failed check must NOT park as pending, and must NOT squash-merge.
    expect((task.error as string | null | undefined) ?? "").not.toContain("PR CHECKS PENDING");
    expect((task.mergeDetails as { prLanding?: { state?: string } }).prLanding).toBeUndefined();
    expect(git(originDir, "rev-parse main")).toBe(originMainBefore);
  });

  it("keeps the non-fatal push-failure contract when the fallback cannot create the PR", async () => {
    const { dir, originDir } = initRepoWithRemote({ rulesetOnMain: true });
    const originMainBefore = git(originDir, "rev-parse main");
    const { store, storeMocks, logs } = makeStore();
    rulesetPrLandingTestHooks.setDeps({
      gh: async (args) => {
        throw new GhCommandError(args, 1, "could not create pull request", "command failed: gh pr create");
      },
    });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    // Fallback failed → the ORIGINAL ruleset rejection keeps the existing non-fatal contract.
    expect(result.pushedToRemote).toBe(false);
    expect(result.pushError).toContain("failed to push some refs");
    expect(logs.some((l) => l.action === "RulesetPrLandingFailed")).toBe(true);
    expect(logs.some((l) => l.action === "PushToRemoteFailed")).toBe(true);
    expect(git(originDir, "rev-parse main")).toBe(originMainBefore);
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:ruleset-declined",
      metadata: expect.objectContaining({ outcome: "pr-fallback-engaged" }),
    }));
  });

  it("leaves the local integration ref untouched when a concurrent landing advanced it during the bounded wait", async () => {
    const { dir, originDir } = initRepoWithRemote({ rulesetOnMain: true });
    const { store, task, logs } = makeStore();
    const prUrl = "https://gh.example.test/repo/pull/9";
    let perturbed = false;
    rulesetPrLandingTestHooks.setDeps({
      gh: async (args, cwd) => {
        if (args[0] === "pr" && args[1] === "create") return prUrl;
        if (args[0] === "pr" && args[1] === "checks") {
          if (!perturbed) {
            perturbed = true;
            // A concurrent landing advances local main while the bounded wait runs.
            writeFileSync(join(cwd, "concurrent.txt"), "concurrent landing\n");
            execSync("git add -A", { cwd, stdio: "pipe" });
            execSync('git -c user.email=c@c.c -c user.name=c commit -q -m "concurrent: other landing"', { cwd, stdio: "pipe" });
          }
          return ""; // green on the next poll
        }
        if (args[0] === "pr" && args[1] === "merge") {
          // Perform the remote squash-merge the way GitHub does (tree of the PR head, CAS parent).
          const originUrl = execSync("git remote get-url origin", { cwd, encoding: "utf-8" }).trim();
          const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t" };
          const headSha = execSync(`git -C "${originUrl}" rev-parse refs/heads/fusion/fn-1`, { encoding: "utf-8", env }).trim();
          const tree = execSync(`git -C "${originUrl}" rev-parse "${headSha}^{tree}"`, { encoding: "utf-8", env }).trim();
          const parent = execSync(`git -C "${originUrl}" rev-parse refs/heads/main`, { encoding: "utf-8", env }).trim();
          const newSha = execSync(`git -C "${originUrl}" commit-tree "${tree}" -p "${parent}" -m "FN-1: squash"`, { encoding: "utf-8", env }).trim();
          execSync(`git -C "${originUrl}" update-ref refs/heads/main "${newSha}" "${parent}"`, { encoding: "utf-8", env, stdio: "pipe" });
          return "";
        }
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
      sleep: () => Promise.resolve(),
    });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    const originMain = git(originDir, "rev-parse main");
    // The PR delivered: origin/main has the squash; the recorded landing points at it.
    expect(result.pushedToRemote).toBe(true);
    expect((task.mergeDetails as { commitSha?: string }).commitSha).toBe(originMain);
    // SUBC-011 precedent: the CAS refused the sibling advance (local main moved concurrently),
    // so the local ref keeps the concurrent tip and is NOT overwritten by the fallback.
    expect(git(dir, "rev-parse main")).not.toBe(originMain);
    expect(git(dir, "log --pretty=%s -1 main")).toContain("concurrent: other landing");
    expect(logs.some((l) => l.action === "RulesetPrLanding" && l.message.includes("could not be advanced locally"))).toBe(true);
  });

  it("delivers a diverged ruleset-declined landing through the PR path with both remote and local commits preserved", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const fakeGh = installFakeGh();
    // Remote moves ahead AFTER our clone, and THEN the ruleset goes active: the fast-path push
    // must be declined by the ruleset hook.
    advanceOrigin(originDir, "remote.txt");
    installRulesetHook(originDir);
    const { store, task } = makeStore();

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    const originMain = git(originDir, "rev-parse main");
    expect(result.pushedToRemote).toBe(true);
    // The PR squash landed on top of the remote commit; local main was synced to the same tip.
    expect(git(dir, "rev-parse main")).toBe(originMain);
    const subjects = git(dir, "log --pretty=%s main");
    expect(subjects).toContain("remote: remote.txt");
    expect(subjects).toMatch(/FN-1: /);
    expect((task.mergeDetails as { commitSha?: string }).commitSha).toBe(originMain);
    expect(readFileSync(fakeGh.logFile, "utf-8")).toContain("pr merge https://gh.example.test/repo/pull/42 --squash");
  });
});
