---
"@runfusion/fusion": patch
---

summary: Worktree refresh no longer discards unlanded commits when rebuilding a task branch.
category: fix
dev: Executor worktree acquisition measures `rev-list --count <base>..<branchTip>` before any branch re-create or dependency import; a nonzero count skips the rebuild and import, keeps the existing checkout, and emits `worktree:branch-refresh-refused` run-audit. Workspace per-repo acquisition (FN-9059) is explicitly out of scope.
