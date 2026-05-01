---
name: claude-result
description: Show stored output for a completed Claude Code plugin job.
---

# Claude Result

Run the companion result command and present its output.

Resolve `<plugin root>` as the `plugins/claude` directory that contains this skill, then run:

```bash
node "<plugin root>/scripts/claude-companion.mjs" result "$ARGUMENTS"
```

Pass a job ID when the user asks for a specific job.
