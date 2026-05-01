# Claude Code Plugin For Codex

Use Claude Code from inside Codex for code reviews, adversarial reviews, delegated implementation tasks, and background job control.

## What You Get

- `claude-review` for a normal read-only Claude review
- `claude-adversarial-review` for a steerable challenge review
- `claude-rescue`, `claude-status`, `claude-result`, and `claude-cancel` to delegate work and manage background jobs
- `claude-setup` for readiness checks and review-gate settings

## Requirements

- Claude Code installed and authenticated
- Node.js 18.18 or later

Install Claude Code if needed:

```bash
npm install -g @anthropic-ai/claude-code
```

Then authenticate:

```bash
claude auth login
```

## Install

Add this repository as a Codex plugin marketplace:

```bash
codex plugin marketplace add <repo-or-local-path>
```

Install or enable the `claude` plugin from that marketplace in Codex, then start a new Codex session so the skills load.

Run:

```text
claude-setup
```

## Usage

### `claude-review`

Runs a read-only Claude review on your current work.

Examples:

```text
claude-review
claude-review --base main
claude-review --background
```

### `claude-adversarial-review`

Runs a review that challenges the implementation approach, design choices, tradeoffs, and assumptions.

Examples:

```text
claude-adversarial-review
claude-adversarial-review --base main challenge the caching and retry design
claude-adversarial-review --background look for race conditions
```

### `claude-rescue`

Delegates investigation, implementation, or follow-up work to Claude Code.

Examples:

```text
claude-rescue investigate why the tests started failing
claude-rescue --write fix the failing test with the smallest safe patch
claude-rescue --resume apply the top fix from the last run
claude-rescue --background investigate the regression
```

### `claude-status`

Shows active and recent Claude jobs for the current repository.

```text
claude-status
claude-status task-abc123
claude-status task-abc123 --wait
```

### `claude-result`

Shows stored output for a finished Claude job.

```text
claude-result
claude-result task-abc123
```

### `claude-cancel`

Cancels an active background Claude job.

```text
claude-cancel
claude-cancel task-abc123
```

### `claude-setup`

Checks whether Claude Code is installed and authenticated. It can also toggle the optional stop-time review gate:

```text
claude-setup --enable-review-gate
claude-setup --disable-review-gate
```

## Runtime

The plugin launches your local `claude` binary with `claude -p --output-format stream-json`. Reviews run with edit tools disabled. Delegated tasks run read-only by default; pass `--write` when Claude should be allowed to edit files.

Job state is stored per repository so background output can be retrieved in later Codex turns.
