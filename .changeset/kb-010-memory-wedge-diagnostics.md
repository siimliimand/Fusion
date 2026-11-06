---
"@runfusion/fusion": patch
---

summary: Detects and self-recovers daily engine memory wedges with heap snapshots, bounded session history, and stall self-exit.
category: fix
dev: Requires the operator drop-in (/etc/systemd/system/fusion.service.d/override.conf: NODE_OPTIONS=--max-old-space-size=4096, MemoryHigh=12G; never MemoryMax). Snapshot dir <root>/.fusion/diagnostics/heapsnapshots (0700, retention 3).
