---
"@runfusion/fusion": patch
---

summary: Mission interviews accept bare question and milestone JSON payloads instead of dying at "Invalid response structure".
category: fix
dev: Normalizes envelope-less payloads before validation in `parseMissionAgentResponse` and emits the bounded `mission:interview-envelope-repaired` diagnostic counter; ambiguous shapes are still rejected.
