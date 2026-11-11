---
"@runfusion/fusion": patch
---

summary: On saturated boards, review cards blocked only by a failed pre-merge step now visibly wait for capacity
category: fix
dev: `getInReviewStallReason` capacity suppression now covers the exact `task has failed pre-merge workflow steps` merge-blocker reason (`FAILED_PRE_MERGE_STEPS_BLOCKER`, shared with `getTaskMergeBlocker` and the self-healing match site); existing `task:in-review-stall-capacity-suppressed` audit event reused unchanged.
