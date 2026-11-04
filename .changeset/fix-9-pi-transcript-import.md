---
"@runfusion/fusion": patch
---

summary: Fix pi extension load failure from the retired pi-ai transcript subpath import.
category: fix
dev: pi-claude-cli/droid-cli now anchor pi-ai transcript helpers on the alias-exact `./compat` entry; boot smoke fails the gate on any `[extensions] Failed to load` line.
