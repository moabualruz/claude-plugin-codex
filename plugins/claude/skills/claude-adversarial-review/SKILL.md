---
name: claude-adversarial-review
description: Run a steerable adversarial Claude Code review from Codex that challenges design and implementation choices.
---

# Claude Adversarial Review

Run the companion adversarial-review command and return its output. This workflow is review-only; do not edit files based on review output.

Resolve `<plugin root>` as the `plugins/claude` directory that contains this skill, then run:

```bash
node "<plugin root>/scripts/claude-companion.mjs" adversarial-review "$ARGUMENTS"
```

Supported arguments: `--wait`, `--background`, `--base <ref>`, `--scope auto|working-tree|branch`, followed by optional focus text.
