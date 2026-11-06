---
"@runfusion/fusion": patch
---

summary: External-block Retry refuses a user-paused card with a clear conflict instead of restarting its stage.
category: fix
dev: The guard reads `task.userPaused === true` in both the locked resume preflight and the retarget wrapper's live re-check; refusals mutate nothing and emit no audit row.
