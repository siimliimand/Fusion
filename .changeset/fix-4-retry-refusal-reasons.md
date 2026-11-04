---
"@runfusion/fusion": patch
---
summary: Dashboard Retry on a landed card now names the exact blocker instead of a generic conflict.
category: fix
dev: `PostMergeGateResumeResult`'s refused arm carries a machine `reason` (merge-active, lease-fresh, execution-live, finalize-blocker, active-work-items, workflow-selection-changed, not-due) plus the blocking work item; the Retry route maps each reason to a precise 409 message. The 15/30/60-min automatic recheck backoff is unchanged.
