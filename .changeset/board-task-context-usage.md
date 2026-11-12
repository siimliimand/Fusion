---
"@runfusion/fusion": minor
---

summary: Show live AI context-window usage per task on the board.
category: feature
dev: GET /api/tasks attaches a transient `contextUsage` snapshot (tokens, model window, percent) read from the executor's active sessions; TaskCard renders a footer chip with a warning tone at >=80% occupancy. Idle tasks render nothing. Distinct from cumulative billed `tokenUsage`.
