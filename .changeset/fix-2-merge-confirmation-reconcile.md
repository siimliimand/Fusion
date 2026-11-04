---
"@runfusion/fusion": patch
---

summary: False merge confirmations self-heal or re-open the merge instead of deferring forever.
category: fix
dev: `recoverConfirmedMergePush` reconciles a confirmed SHA that is not an ancestor of the target branch — content-match rewrites `mergeDetails.commitSha` to the main-side commit; a true phantom is un-confirmed in one atomic fence, the merge is re-opened in-column via `replaceActiveTaskWorkflowContinuation` (audit `merge:confirmed-merge-reconciled`), bounded at 3 attempts then parked with `MERGE-CONFIRMED RECONCILIATION EXHAUSTED`. Reconciliation is allowed for `autoMerge:false` cards; workspace tasks are out of scope (per-repo landing records).
