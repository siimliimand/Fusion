---
"@runfusion/fusion": minor
---

summary: Automatically restarts an unresponsive Fusion service via systemd watchdog integration.
category: feature
dev: sd_notify helper (execs `systemd-notify`, zero npm deps) wired into dashboard/serve/daemon listening paths; host unit gains `Type=notify` + `NotifyAccess=all` + `WatchdogSec=180`.
