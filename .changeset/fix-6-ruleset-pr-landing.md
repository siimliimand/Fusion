---
"@runfusion/fusion": minor
---
summary: Merger lands via pull request automatically when the remote requires status checks
category: feature
dev: FIX-6. Feature-detected fallback: a ruleset-declined landing push (`remote rejected` + repository rule signature) switches that landing to a PR flow (task-branch head, bounded `gh pr checks` wait capped at 15 min, squash-merge preserving the commit message), then syncs the local integration ref inside the merge-write fence and reconciles `mergeDetails.commitSha` to the post-merge tip. Checks-timeout parks the card with `PR CHECKS PENDING: <pr url>` plus durable `mergeDetails.prLanding` state; a retry re-detects the existing PR and converges. Workspace lands and `merging-pr` tasks keep their existing machinery; rulesets are never read or mutated.
