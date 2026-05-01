# Claude Plugin For Codex Full-Parity Design

## Goal

Fork `openai/codex-plugin-cc` into a Codex plugin that lets Codex run Claude Code with the same user-facing workflow coverage that the upstream Claude plugin provides for Codex.

The fork should become `claude-plugin-codex`: a Codex plugin named `claude` that supports setup, review, adversarial review, delegated tasks, background job status, result retrieval, cancellation, and an optional review gate where Codex plugin hooks can support it.

Full parity means workflow parity, not identical internals. The upstream plugin uses Codex app-server APIs. Claude Code does not expose the same app-server protocol, so the reverse plugin will use Claude Code's CLI surfaces and stream output parsing.

## User-Facing Parity

The plugin should cover these upstream workflows with Claude equivalents:

- `setup`: verify Node, npm, Claude Code availability, Claude authentication readiness, and plugin runtime state.
- `review`: run a read-only Claude review against the current working tree or a branch compared with a base ref.
- `adversarial-review`: run a steerable challenge review that questions implementation approach, risks, and tradeoffs.
- `task` / `rescue`: delegate investigation, implementation, or follow-up work to Claude Code.
- `status`: show current and recent background Claude jobs for the current repository/session.
- `result`: show stored output from a completed Claude job.
- `cancel`: terminate active background Claude jobs.
- Review gate: optionally require a fresh Claude review before a Codex session ends when Codex plugin hooks can enforce it.

Codex currently does not expose Claude-style slash commands in the local CLI surface. The plugin should provide command-like Codex skills with stable names and a Node companion script. The user-facing names should map directly to the upstream names, for example `claude-review`, `claude-adversarial-review`, `claude-rescue`, `claude-status`, `claude-result`, `claude-cancel`, and `claude-setup`.

## Repository Shape

The fork keeps the upstream testable Node runtime pattern but renames the product boundary:

- `.agents/plugins/marketplace.json`: Codex marketplace entry.
- `plugins/claude/.codex-plugin/plugin.json`: Codex plugin manifest.
- `plugins/claude/scripts/claude-companion.mjs`: main runtime entrypoint.
- `plugins/claude/scripts/lib/*.mjs`: ported runtime helpers.
- `plugins/claude/skills/*/SKILL.md`: Codex-facing command wrappers.
- `plugins/claude/hooks/hooks.json`: optional hook registration if local Codex plugin hooks are sufficient.
- `tests/*.test.mjs`: renamed and adjusted tests preserving upstream behavioral coverage.

Upstream `.claude-plugin` metadata, Claude slash-command files, and Claude agents should be removed or replaced with Codex plugin equivalents.

## Runtime Architecture

`claude-companion.mjs` should remain the single process entrypoint for all workflows. It will parse command arguments, resolve repository state, manage jobs, render output, and call Claude Code.

Claude execution should use:

- Foreground task/review: `claude -p --output-format stream-json ...`
- Plain fallback: `claude -p --output-format text ...` when stream output is unavailable or too unstable.
- Write-capable delegated tasks: Claude permission mode selected from user flags, defaulting to write-capable only for explicit rescue/task flows.
- Read-only reviews: permissions restricted to inspection commands and no edit tools where Claude Code supports those controls.

The runtime should parse Claude stream-json events into the same internal job model used by upstream where possible:

- lifecycle phase
- progress message
- final assistant text
- command execution summaries when present
- file change summaries when present
- error output
- cancellation status

Because Claude stream events differ from Codex app-server notifications, parser tests should focus on stable observed fields and tolerate unknown event types.

## Review Behavior

Review target selection should keep upstream behavior:

- `--scope auto|working-tree|branch`
- `--base <ref>`
- include untracked files for working-tree review
- treat empty review targets accurately
- support foreground/background execution

The review prompt should ask Claude for actionable findings first, ordered by severity, with file/line references where possible. It should preserve the upstream "normal review" versus "adversarial review" split:

- Normal review: defects, regressions, missing tests, unsafe behavior.
- Adversarial review: challenge assumptions, design choices, failure modes, and simpler alternatives.

## Background Jobs

The fork should preserve upstream job state semantics:

- repository-scoped state directory
- generated job IDs
- job logs
- current/recent status snapshots
- latest result resolution
- cancellation by explicit ID or current active job
- current-session scoping when available

Implementation can reuse most upstream state, render, git, process, workspace, and job-control helpers after renaming and adapting product strings.

## Setup And Auth

`setup` should report:

- Node availability
- npm availability
- `claude` binary availability and version
- Claude Code auth readiness
- whether stream-json mode works
- review gate state
- next steps

Auth readiness should be checked conservatively. Prefer a low-cost CLI command such as `claude --version` for availability and a short non-interactive dry run only when needed to detect auth failures. The setup command must not consume significant user quota just to check readiness.

Install guidance should prefer the official Claude Code install path available in the local CLI/docs at implementation time. If npm install remains appropriate, the setup flow can offer `npm install -g @anthropic-ai/claude-code`.

## Codex Integration

Codex plugin integration should follow current Codex plugin conventions:

- `.codex-plugin/plugin.json` for plugin metadata.
- `.agents/plugins/marketplace.json` for local marketplace registration.
- skills for command-like workflows.
- hooks only if supported by the installed Codex version.

The skills should be thin wrappers. They should forward user intent to `node "${CODEX_PLUGIN_ROOT}/scripts/claude-companion.mjs" ...` or the environment variable Codex exposes for plugin root. If the root variable differs from `CODEX_PLUGIN_ROOT`, implementation should detect and document the supported variable.

## Testing

Preserve upstream coverage style with fake CLI fixtures:

- fake `claude` executable for setup, review, task, stream-json events, auth failure, and cancellation.
- tests for argument parsing and command routing.
- tests for git target selection.
- tests for status/result/cancel state behavior.
- tests for stream-json parsing.
- tests for rendered output.

Project verification should use:

- `npm test`
- `npm run build` if TypeScript generation remains relevant.

If the upstream build depends on Codex app-server generated types that no longer apply, replace that build step with a testable local typecheck or remove the generated app-server dependency.

## Acceptance Criteria

- Fresh install as a Codex plugin from the local marketplace works.
- `claude-setup` reports accurate readiness and next steps.
- `claude-review` can review working-tree and base-branch changes without editing files.
- `claude-adversarial-review` accepts focus text and remains read-only.
- `claude-rescue` can run foreground and background delegated work.
- `claude-status`, `claude-result`, and `claude-cancel` manage stored jobs.
- Background job output persists across Codex turns.
- Tests pass with fake Claude fixtures.
- Documentation no longer describes the plugin as "Codex for Claude Code"; it describes "Claude Code for Codex."

## Risks

- Codex plugin skills may not fully match Claude slash-command ergonomics. Mitigation: keep thin skills with direct runtime commands and clear names.
- Claude Code stream-json schema may drift. Mitigation: tolerant parser with fixture tests and fallback text mode.
- Review gate may be blocked by Codex plugin hook maturity. Mitigation: implement the script and enable hook registration only when the local Codex version supports it.
- Auth probing can accidentally burn quota. Mitigation: prefer version/config checks and use minimal prompts only when required.
