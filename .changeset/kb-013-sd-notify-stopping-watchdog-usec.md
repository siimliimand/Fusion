---
"@runfusion/fusion": minor
---

summary: Watchdog pings now follow the unit's WatchdogSec budget and graceful stops tell systemd they are deliberate.
category: feature
dev: sd_notify helper gains STOPPING=1 on graceful shutdown (dashboard/serve/daemon) and derives the ping interval from $WATCHDOG_USEC (budget/6, 30s fallback); transport stays `systemd-notify` exec.
