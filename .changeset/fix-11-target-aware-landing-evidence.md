---
"@runfusion/fusion": patch
---

summary: Post-merge landing evidence now audits the recorded landing branch instead of the project default
category: fix
dev: The mergeConfirmed reachability gate resolves its audit branch target-first (`mergeDetails.mergeTargetBranch`, with `resolveIntegrationBranch` as fallback only), the post-merge verification step receives the landing reference branch and tip in its evidence context, the required post-landing run is scoped to that reference branch, and target-divergent landings emit the bounded `merge:target-branch-divergence` audit event. Rows without a recorded target keep today's behavior. Motivated by SUBC-013 (SUBC-013's mission-branch landing was audited against main, stranding a landed card in merge-confirmed limbo).
