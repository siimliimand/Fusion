---
"@runfusion/fusion": patch
---

summary: Saturated boards no longer auto-fail healthy review cards; they visibly wait for capacity and merge when a slot frees.
category: fix
dev: `surfaceInReviewStalls` now computes project capacity via `computeTopLevelConcurrencyClaimedFromStore`/`resolveMaxConcurrentSetting`, suppresses the waiting-for-a-slot stall codes under saturation, re-drives the merge handoff once before disposal with free capacity, and emits `task:in-review-stall-capacity-suppressed` through the bounded audit seam.
