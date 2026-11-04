---
"@runfusion/fusion": patch
---

summary: External-block Retry restarts the current stage when the frozen resume node belongs to an earlier column.
category: fix
dev: Stale-node detection compares the resolved resume node's column with the task's column using the resolved workflow's ordered columns; the retarget publishes through the same restart-stage fence as Retry (no new lifecycle authority).
