---
"@runfusion/fusion": minor
---

summary: Capacity-suspended cards now resume as soon as an agent slot frees instead of waiting for the recovery sweep.
category: fix
dev: Uses project setting key `planReviewCapacityWakeAgeMinutes` (default 30; 0 disables the poll-boundary age gate) and emits the `task:capacity-wake-resumed` run-audit event through the bounded seam.
