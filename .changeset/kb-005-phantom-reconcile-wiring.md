---
"@runfusion/fusion": patch
---

summary: Phantom merge confirmations are now also reconciled by self-healing sweeps and finalization-blocked detection.
category: fix
dev: `reconcilePhantomMergeConfirmations` self-healing step (startup + maintenance batch 2, max 5 candidates/tick) delegates to `recoverConfirmedMergePush`, which now falls back recorded merge target → task `baseBranch` → resolved project default for rows without a recorded target, drops the false-landing fields (`mergedAt`, stat/no-op attribution) on un-confirm, adds `branch` to the `merge:confirmed-merge-reconciled` audit metadata, and accepts an optional liveness probe completing the canonical liveness triple.
