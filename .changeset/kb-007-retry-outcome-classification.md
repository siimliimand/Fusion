---
"@runfusion/fusion": patch
---

summary: Task Retry API reports reseeded/deferred/refused outcomes and logs every landed-verification retry.
category: fix
dev: POST /tasks/:id/retry refusals now carry details {outcome, reason, workItem?}; paused and engine-paused refusals name the actual state; every landed-verification retry outcome writes a task-log entry.
