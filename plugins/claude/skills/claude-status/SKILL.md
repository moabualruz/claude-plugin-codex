---
name: claude-status
description: Show active and recent Claude Code plugin jobs for the current repository.
---

# Claude Status

Run the companion status command and present its output.

Resolve `<plugin root>` as the `plugins/claude` directory that contains this skill, then run:

```bash
node "<plugin root>/scripts/claude-companion.mjs" status "$ARGUMENTS"
```

Supported arguments: optional job ID, `--wait`, `--timeout-ms <ms>`, `--all`, and `--json`.
