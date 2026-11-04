---
"@runfusion/fusion": patch
---

summary: Self-healing now fails orphaned active workflow work items whose owning run is dead.
category: fix
dev: New `reconcile-orphaned-active-work-items` sweep (startup + periodic) with liveness-triple veto, staleness floor, merge-pending/merge-active exclusions, one 3-item budget per sweep, and `task:reconcile-orphaned-work-item`(+deduped `-no-action`) bounded audit events.
