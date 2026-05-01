---
name: claude-setup
description: Check whether local Claude Code is ready for the Claude plugin for Codex, and enable or disable the optional review gate.
---

# Claude Setup

Run the companion setup command and present its output.

Resolve `<plugin root>` as the `plugins/claude` directory that contains this skill, then run:

```bash
node "<plugin root>/scripts/claude-companion.mjs" setup "$ARGUMENTS"
```

Use `--enable-review-gate` or `--disable-review-gate` when requested.
