---
name: claude-rescue
description: Delegate investigation, implementation, or follow-up work from Codex to Claude Code.
---

# Claude Rescue

Run the companion task command and return its output. Use this when the user wants Claude Code to investigate, implement, continue, or take a second pass.

Resolve `<plugin root>` as the `plugins/claude` directory that contains this skill, then run:

```bash
node "<plugin root>/scripts/claude-companion.mjs" task "$ARGUMENTS"
```

Supported arguments: `--background`, `--write`, `--resume-last`, `--resume`, `--fresh`, `--model <model>`, `--effort <low|medium|high|xhigh|max>`, and prompt text.
