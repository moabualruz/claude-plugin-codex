---
name: claude-review
description: Run a read-only Claude Code review from Codex against the working tree or a base branch.
---

# Claude Review

Run the companion review command and return its output. This workflow is review-only; do not edit files based on review output.

Resolve `<plugin root>` as the `plugins/claude` directory that contains this skill, then run:

```bash
node "<plugin root>/scripts/claude-companion.mjs" review "$ARGUMENTS"
```

Supported arguments: `--wait`, `--background`, `--base <ref>`, and `--scope auto|working-tree|branch`.
