import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../../executor.js";
import { detectUnlandedBranchCommits } from "../worktree-create-outer.js";

/*
 * FNXC:WorktreeUnlandedGuard 2026-11-04-09:39:
 * SUBC-011 regression at the git layer: re-acquisition must never move a fusion/<taskId> branch
 * whose tip carries commits the acquisition base does not contain. The unlanded tip, its worktree,
 * and the branch ref must survive acquisition byte-identically, the refusal must be observable in
 * the task log and run audit, and a fully-landed tip must keep today's acquisition behavior.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function commitFile(rootDir: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(file, content);
  git(rootDir, ["add", "-A"]);
  git(rootDir, ["-c", "user.name=Fusion Test", "-c", "user.email=fusion-test@example.test", "-c", "commit.gpgsign=false", "commit", "-m", message]);
  return git(rootDir, ["rev-parse", "HEAD"]);
}

function createExecutor(rootDir: string) {
  const store = {
    on: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      commitMsgHookEnabled: false,
      worktreeRebaseBeforeMerge: false,
    }),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  };
  return { executor: new TaskExecutor(store as never, rootDir), store };
}

function auditEvents(store: { recordRunAuditEvent: ReturnType<typeof vi.fn> }, mutationType: string) {
  return store.recordRunAuditEvent.mock.calls
    .map(([event]) => event as { mutationType?: string; metadata?: Record<string, unknown> })
    .filter((event) => event.mutationType === mutationType);
}

describe("worktree acquisition unlanded-branch guard", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
  });

  async function createFixtureRepo(): Promise<string> {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-unlanded-guard-"));
    tempRoots.push(rootDir);
    git(rootDir, ["init", "--initial-branch=main"]);
    git(rootDir, ["config", "user.name", "Fusion Test"]);
    git(rootDir, ["config", "user.email", "fusion-test@example.test"]);
    return rootDir;
  }

  it("detects unlanded commits between a branch tip and its base", async () => {
    const rootDir = await createFixtureRepo();
    const baseSha = await commitFile(rootDir, join(rootDir, "base.txt"), "base\n", "base commit");
    git(rootDir, ["branch", "fusion/fn-guard"]);
    git(rootDir, ["checkout", "-q", "fusion/fn-guard"]);
    const taskSha = await commitFile(rootDir, join(rootDir, "impl.txt"), "impl\n", "task work");
    git(rootDir, ["checkout", "-q", "main"]);
    const mainSha = await commitFile(rootDir, join(rootDir, "main.txt"), "main\n", "main moves on");

    expect(await detectUnlandedBranchCommits(rootDir, "fusion/fn-guard", mainSha)).toEqual({
      unlanded: true,
      unlandedCommitCount: 1,
      branchTipSha: taskSha,
      baseTipSha: mainSha,
    });
    // The stale-base shape (branch fully contained in a newer base) is not unlanded.
    git(rootDir, ["update-ref", "refs/heads/fusion/fn-guard", baseSha]);
    expect(await detectUnlandedBranchCommits(rootDir, "fusion/fn-guard", mainSha)).toEqual({
      unlanded: false,
      unlandedCommitCount: 0,
      branchTipSha: baseSha,
      baseTipSha: mainSha,
    });
    // Fail-open: unknown branch or unresolvable base never reports unlanded.
    expect(await detectUnlandedBranchCommits(rootDir, "fusion/fn-missing", mainSha)).toEqual({ unlanded: false, unlandedCommitCount: 0 });
    expect(await detectUnlandedBranchCommits(rootDir, "fusion/fn-guard", "no-such-ref")).toEqual({ unlanded: false, unlandedCommitCount: 0 });
  });

  it("keeps an unlanded branch tip intact when acquisition would rebuild it with imported dep content", async () => {
    const rootDir = await createFixtureRepo();
    const baseSha = await commitFile(rootDir, join(rootDir, "base.txt"), "base\n", "base commit");
    // A sibling dependency branch whose content would normally be squash-imported.
    git(rootDir, ["checkout", "-q", "-b", "fusion/fn-dep"]);
    await commitFile(rootDir, join(rootDir, "dep.txt"), "dep\n", "dep work");
    git(rootDir, ["checkout", "-q", "main"]);
    // The task branch carries one unlanded implementation commit (the SUBC-011 state).
    git(rootDir, ["checkout", "-q", "-b", "fusion/fn-guard"]);
    const taskSha = await commitFile(rootDir, join(rootDir, "impl.txt"), "impl\n", "task work");
    git(rootDir, ["checkout", "-q", "main"]);

    const { executor, store } = createExecutor(rootDir);
    const createWorktree = (executor as unknown as {
      createWorktree: (
        branch: string,
        path: string,
        taskId: string,
        startPoint?: string,
      ) => Promise<{ path: string; branch: string }>;
    }).createWorktree.bind(executor);
    const worktreePath = join(rootDir, ".worktrees", "guard");

    // Acquisition still resolves: the node executes against a checkout of the unlanded branch.
    const created = await createWorktree("fusion/fn-guard", worktreePath, "FN-GUARD", "fusion/fn-dep");

    // SYMPTOM VERIFICATION (SUBC-011): the branch ref is unchanged after acquisition.
    expect(git(rootDir, ["rev-parse", "refs/heads/fusion/fn-guard"])).toBe(taskSha);
    expect(created.branch).toBe("fusion/fn-guard");
    expect(realpathSync(created.path)).toBe(realpathSync(worktreePath));
    expect(git(worktreePath, ["rev-parse", "HEAD"])).toBe(taskSha);
    expect(git(worktreePath, ["status", "--porcelain"])).toBe("");
    // The dependency import never ran: no "import dependency content" commit exists.
    expect(git(worktreePath, ["log", "--format=%s"])).not.toContain("import dependency content from");
    // The refusal is observable on both surfaces, with counts/ids only.
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-GUARD",
      expect.stringContaining("Worktree refresh skipped: branch fusion/fn-guard has 1 commit(s) not in"),
    );
    const refusals = auditEvents(store, "worktree:branch-refresh-refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].metadata).toMatchObject({
      taskId: "FN-GUARD",
      branch: "fusion/fn-guard",
      unlandedCommitCount: 1,
      outcome: "skipped",
    });
    expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("leaves an existing registered worktree untouched when its branch has unlanded commits", async () => {
    const rootDir = await createFixtureRepo();
    await commitFile(rootDir, join(rootDir, "base.txt"), "base\n", "base commit");
    git(rootDir, ["checkout", "-q", "-b", "fusion/fn-dep"]);
    await commitFile(rootDir, join(rootDir, "dep.txt"), "dep\n", "dep work");
    git(rootDir, ["checkout", "-q", "main"]);
    git(rootDir, ["checkout", "-q", "-b", "fusion/fn-reuse"]);
    await commitFile(rootDir, join(rootDir, "impl.txt"), "impl\n", "task work");
    const taskSha = git(rootDir, ["rev-parse", "HEAD"]);
    git(rootDir, ["checkout", "-q", "main"]);

    const { executor, store } = createExecutor(rootDir);
    const createWorktree = (executor as unknown as {
      createWorktree: (
        branch: string,
        path: string,
        taskId: string,
        startPoint?: string,
      ) => Promise<{ path: string; branch: string }>;
    }).createWorktree.bind(executor);
    const worktreePath = join(rootDir, ".worktrees", "reuse");
    git(rootDir, ["worktree", "add", worktreePath, "fusion/fn-reuse"]);

    const result = await createWorktree("fusion/fn-reuse", worktreePath, "FN-REUSE", "fusion/fn-dep");

    // Same checkout, same branch tip, no import commit layered on the unlanded work.
    expect(realpathSync(result.path)).toBe(realpathSync(worktreePath));
    expect(result.branch).toBe("fusion/fn-reuse");
    expect(git(rootDir, ["rev-parse", "refs/heads/fusion/fn-reuse"])).toBe(taskSha);
    expect(git(worktreePath, ["rev-parse", "HEAD"])).toBe(taskSha);
    expect(git(worktreePath, ["log", "--format=%s"])).not.toContain("import dependency content from");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-REUSE",
      expect.stringContaining("Worktree refresh skipped: branch fusion/fn-reuse has 1 commit(s) not in"),
    );
    expect(auditEvents(store, "worktree:branch-refresh-refused")).toHaveLength(1);
  });

  it("proceeds exactly as today when the branch tip is fully contained in the base", async () => {
    const rootDir = await createFixtureRepo();
    const baseSha = await commitFile(rootDir, join(rootDir, "base.txt"), "base\n", "base commit");
    git(rootDir, ["checkout", "-q", "-b", "fusion/fn-dep"]);
    await commitFile(rootDir, join(rootDir, "dep.txt"), "dep\n", "dep work");
    git(rootDir, ["checkout", "-q", "main"]);
    // Task branch forked at base with zero own commits; its tip is an ancestor of any newer base.
    git(rootDir, ["branch", "fusion/fn-landed", baseSha]);

    const { executor, store } = createExecutor(rootDir);
    const createWorktree = (executor as unknown as {
      createWorktree: (
        branch: string,
        path: string,
        taskId: string,
        startPoint?: string,
      ) => Promise<{ path: string; branch: string }>;
    }).createWorktree.bind(executor);
    const worktreePath = join(rootDir, ".worktrees", "landed");

    const created = await createWorktree("fusion/fn-landed", worktreePath, "FN-LANDED", "fusion/fn-dep");

    expect(created.branch).toBe("fusion/fn-landed");
    expect(realpathSync(created.path)).toBe(realpathSync(worktreePath));
    expect(git(worktreePath, ["status", "--porcelain"])).toBe("");
    // The dependency import ran as before; no refusal surfaced anywhere.
    expect(git(worktreePath, ["log", "--format=%s"])).toContain(
      "chore(FN-LANDED): import dependency content from fusion/fn-dep",
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-LANDED",
      expect.stringContaining("Worktree refresh skipped"),
    );
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });
});
