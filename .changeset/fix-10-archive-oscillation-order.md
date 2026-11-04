---
"@runfusion/fusion": patch
---

summary: Archive moves now clear dispatch oscillation state instead of failing on soft-deleted rows.
category: fix
dev: The archive transition clears the scheduler's oscillation fields before the snapshot/emit and nulls the persisted requeue-loop columns in the same soft-delete UPDATE, so the post-move reset no longer writes against a soft-deleted row.
