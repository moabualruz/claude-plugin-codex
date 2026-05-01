---
name: claude-cancel
description: Cancel an active background Claude Code plugin job.
---

# Claude Cancel

Run the companion cancel command and present its output.

Resolve `<plugin root>` as the `plugins/claude` directory that contains this skill, then run:

```bash
node "<plugin root>/scripts/claude-companion.mjs" cancel "$ARGUMENTS"
```

Pass a job ID when more than one background job is active.
