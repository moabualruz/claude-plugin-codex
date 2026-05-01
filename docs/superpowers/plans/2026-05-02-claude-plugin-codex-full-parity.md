# Claude Plugin For Codex Full-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the cloned `openai/codex-plugin-cc` repository in place into a Codex plugin that runs Claude Code with full workflow parity.

**Architecture:** Keep the upstream Node companion/runtime model, state store, renderers, git helpers, and test style. Replace the Codex app-server runtime boundary with a Claude Code CLI runtime that invokes `claude -p --output-format stream-json`, parses tolerant JSON-line events, and falls back to text output where needed.

**Tech Stack:** Node.js ESM, `node:test`, Claude Code CLI, Codex plugin manifests/skills, existing upstream job-state helpers.

---

## File Map

- Rename `.claude-plugin/marketplace.json` to `.agents/plugins/marketplace.json`: Codex marketplace metadata.
- Rename `plugins/codex` to `plugins/claude`: plugin root.
- Rename `plugins/claude/.claude-plugin/plugin.json` to `plugins/claude/.codex-plugin/plugin.json`: Codex plugin manifest.
- Replace `plugins/claude/scripts/lib/codex.mjs` with `plugins/claude/scripts/lib/claude.mjs`: Claude CLI availability, auth, execution, stream parser, and structured output helpers.
- Rename `plugins/claude/scripts/codex-companion.mjs` to `plugins/claude/scripts/claude-companion.mjs`: command dispatcher, job orchestration, review/task/status/result/cancel handling.
- Keep `plugins/claude/scripts/lib/args.mjs`, `fs.mjs`, `git.mjs`, `job-control.mjs`, `process.mjs`, `prompts.mjs`, `render.mjs`, `state.mjs`, `tracked-jobs.mjs`, `workspace.mjs`: reusable helpers with product-string updates.
- Remove app-server-only helpers after tests no longer import them: `app-server*.mjs`, `broker-*.mjs`, `app-server-protocol.d.ts`.
- Replace `plugins/claude/commands/*` and `plugins/claude/agents/*` with skills under `plugins/claude/skills/claude-{setup,review,adversarial-review,rescue,status,result,cancel}/SKILL.md`.
- Rename `tests/fake-codex-fixture.mjs` to `tests/fake-claude-fixture.mjs`: fake `claude` executable.
- Update tests to import `plugins/claude/...` paths and assert Claude behavior.
- Update `package.json`, `package-lock.json`, `README.md`, `.github/workflows/pull-request-ci.yml`, and `scripts/bump-version.mjs` for the new package/plugin names.

## Task 1: Convert Manifests And Paths

**Files:**
- Rename: `.claude-plugin/marketplace.json` -> `.agents/plugins/marketplace.json`
- Rename: `plugins/codex/` -> `plugins/claude/`
- Rename: `plugins/claude/.claude-plugin/plugin.json` -> `plugins/claude/.codex-plugin/plugin.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/bump-version.mjs`
- Modify: `.github/workflows/pull-request-ci.yml`

- [ ] **Step 1: Write failing metadata test**

Create or update `tests/manifest.test.mjs` to assert:

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("repo exposes a Codex marketplace and Claude plugin manifest", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".agents", "plugins", "marketplace.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "claude", ".codex-plugin", "plugin.json"), "utf8"));

  assert.equal(marketplace.name, "claude-code");
  assert.equal(marketplace.plugins[0].name, "claude");
  assert.deepEqual(marketplace.plugins[0].source, { source: "local", path: "./plugins/claude" });
  assert.equal(manifest.name, "claude");
  assert.match(manifest.description, /Claude Code from Codex/i);
});
```

- [ ] **Step 2: Run metadata test to verify red**

Run: `npm test -- tests/manifest.test.mjs`

Expected: FAIL because `.agents/plugins/marketplace.json` and `plugins/claude/.codex-plugin/plugin.json` do not exist yet.

- [ ] **Step 3: Rename and edit manifests**

Use `git mv` for path moves. Set marketplace entry:

```json
{
  "name": "claude-code",
  "interface": {
    "displayName": "Claude Code"
  },
  "plugins": [
    {
      "name": "claude",
      "source": {
        "source": "local",
        "path": "./plugins/claude"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Set plugin manifest:

```json
{
  "name": "claude",
  "version": "1.0.4",
  "description": "Use Claude Code from Codex to review code or delegate tasks.",
  "author": {
    "name": "OpenAI"
  },
  "license": "Apache-2.0",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "Claude Code",
    "shortDescription": "Run Claude Code from Codex.",
    "longDescription": "Review code, delegate tasks, and manage background Claude Code runs from Codex.",
    "developerName": "OpenAI",
    "category": "Productivity",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Ask Claude to review my changes.",
      "Ask Claude to investigate this bug.",
      "Show Claude task status."
    ],
    "brandColor": "#D97757"
  }
}
```

- [ ] **Step 4: Update package and CI names**

Change package name to `@openai/claude-plugin-codex`; description to `Use Claude Code from Codex to review code or delegate tasks.` Remove Codex app-server prebuild dependency from `package.json`; make `build` a syntax/import check command that does not generate Codex app-server types.

- [ ] **Step 5: Run metadata test to verify green**

Run: `npm test -- tests/manifest.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add . && git commit -m "feat: convert plugin manifests to codex"
```

## Task 2: Add Claude CLI Runtime With Tests

**Files:**
- Create: `plugins/claude/scripts/lib/claude.mjs`
- Delete or stop importing: `plugins/claude/scripts/lib/codex.mjs`
- Create: `tests/claude-runtime.test.mjs`
- Rename: `tests/fake-codex-fixture.mjs` -> `tests/fake-claude-fixture.mjs`

- [ ] **Step 1: Write failing runtime tests**

Add tests for:

```js
test("setup reports fake Claude availability and auth", ...);
test("runClaudePrompt parses stream-json assistant and result output", ...);
test("runClaudePrompt returns nonzero status and stderr on auth failure", ...);
test("parseStructuredOutput parses valid JSON and reports parse errors", ...);
```

- [ ] **Step 2: Run runtime tests to verify red**

Run: `npm test -- tests/claude-runtime.test.mjs`

Expected: FAIL because `plugins/claude/scripts/lib/claude.mjs` and fake Claude fixture do not exist.

- [ ] **Step 3: Implement fake Claude fixture**

Create `installFakeClaude(binDir, behavior = "ok")` that writes executable `claude` supporting:

```text
claude --version
claude auth status --json
claude -p --output-format stream-json [prompt]
claude -p --output-format text [prompt]
```

For stream output, emit JSON lines with `assistant` and `result` objects.

- [ ] **Step 4: Implement Claude runtime**

Export:

```js
export function getClaudeAvailability(cwd) {}
export async function getClaudeAuthStatus(cwd, options = {}) {}
export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {}
export async function runClaudePrompt(cwd, options = {}) {}
export async function interruptClaudeRun(cwd, { sessionId }) {}
export async function findLatestTaskThread(cwd) {}
export function buildPersistentTaskThreadName(prompt) {}
export function parseStructuredOutput(rawOutput, fallback = {}) {}
export function readOutputSchema(schemaPath) {}
export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
```

Use `spawn` with argument arrays, not shell strings, to avoid command injection. Pass user prompt through stdin or a single argv prompt argument; never concatenate prompt into a shell command.

- [ ] **Step 5: Run runtime tests to verify green**

Run: `npm test -- tests/claude-runtime.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add . && git commit -m "feat: add claude cli runtime"
```

## Task 3: Port Companion Commands And Job Control

**Files:**
- Rename: `plugins/claude/scripts/codex-companion.mjs` -> `plugins/claude/scripts/claude-companion.mjs`
- Modify: `plugins/claude/scripts/claude-companion.mjs`
- Modify: `plugins/claude/scripts/lib/render.mjs`
- Modify: `plugins/claude/scripts/session-lifecycle-hook.mjs`
- Modify: `plugins/claude/scripts/stop-review-gate-hook.mjs`
- Modify: `tests/runtime.test.mjs`
- Modify: `tests/render.test.mjs`
- Modify: `tests/state.test.mjs`

- [ ] **Step 1: Write failing companion tests**

Update runtime tests to expect:

```js
const PLUGIN_ROOT = path.join(ROOT, "plugins", "claude");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "claude-companion.mjs");
```

Assert setup, review, adversarial review, task, background task, status, result, cancel, and stop hook flows with fake Claude.

- [ ] **Step 2: Run companion test slice to verify red**

Run: `npm test -- tests/runtime.test.mjs tests/render.test.mjs tests/state.test.mjs`

Expected: FAIL because companion still imports Codex runtime and references old paths/strings.

- [ ] **Step 3: Port companion imports and product strings**

Import Claude runtime exports from `./lib/claude.mjs`. Replace user-visible `Codex` product strings with `Claude`, `/codex:*` references with `claude-*` skill names, and state labels from `Codex Task` to `Claude Task`.

- [ ] **Step 4: Port review/task execution**

Use `runClaudePrompt` for all execution:

- normal review: build read-only prompt from `resolveReviewTarget` and `collectReviewContext`
- adversarial review: keep existing adversarial prompt template and structured JSON schema
- task: pass user prompt or resume prompt to Claude
- background task: keep existing detached worker/job files

- [ ] **Step 5: Port cancel behavior**

Use `terminateProcessTree(job.pid)` for active background workers. `interruptClaudeRun` should return `attempted: false` until Claude exposes a stable external interrupt API.

- [ ] **Step 6: Run companion test slice to verify green**

Run: `npm test -- tests/runtime.test.mjs tests/render.test.mjs tests/state.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add . && git commit -m "feat: port companion runtime to claude"
```

## Task 4: Replace Claude Plugin Commands With Codex Skills

**Files:**
- Delete: `plugins/claude/commands/*.md`
- Delete: `plugins/claude/agents/*.md`
- Create: `plugins/claude/skills/claude-setup/SKILL.md`
- Create: `plugins/claude/skills/claude-review/SKILL.md`
- Create: `plugins/claude/skills/claude-adversarial-review/SKILL.md`
- Create: `plugins/claude/skills/claude-rescue/SKILL.md`
- Create: `plugins/claude/skills/claude-status/SKILL.md`
- Create: `plugins/claude/skills/claude-result/SKILL.md`
- Create: `plugins/claude/skills/claude-cancel/SKILL.md`
- Modify: `tests/commands.test.mjs`

- [ ] **Step 1: Write failing skills tests**

Update `tests/commands.test.mjs` to assert skills exist, have valid frontmatter names, call `claude-companion.mjs`, and contain no `/codex:` or `CLAUDE_PLUGIN_ROOT` command assumptions.

- [ ] **Step 2: Run skills tests to verify red**

Run: `npm test -- tests/commands.test.mjs`

Expected: FAIL because old Claude slash commands still exist.

- [ ] **Step 3: Create thin Codex skill wrappers**

Each skill should instruct Codex to resolve plugin root as the directory two levels above the skill directory and run:

```bash
node "<plugin root>/scripts/claude-companion.mjs" <subcommand> ...
```

Skill names must be `claude-setup`, `claude-review`, `claude-adversarial-review`, `claude-rescue`, `claude-status`, `claude-result`, and `claude-cancel`.

- [ ] **Step 4: Run skills tests to verify green**

Run: `npm test -- tests/commands.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add . && git commit -m "feat: expose claude workflows as codex skills"
```

## Task 5: Docs, Cleanup, And Verification

**Files:**
- Modify: `README.md`
- Modify: `plugins/claude/CHANGELOG.md`
- Modify: `plugins/claude/prompts/adversarial-review.md`
- Modify: `plugins/claude/prompts/stop-review-gate.md`
- Modify: all remaining files returned by `rg -n "codex|Codex|CLAUDE_PLUGIN|\\.claude-plugin|/codex:"`

- [ ] **Step 1: Write failing cleanup test**

Add `tests/product-copy.test.mjs` that allows code identifiers only in expected places and fails on user-visible upstream copy such as `Codex plugin for Claude Code`, `/codex:`, `.claude-plugin`, and `@openai/codex-plugin-cc`.

- [ ] **Step 2: Run cleanup test to verify red**

Run: `npm test -- tests/product-copy.test.mjs`

Expected: FAIL with existing upstream copy.

- [ ] **Step 3: Update documentation and remaining copy**

Rewrite README install/usage for Codex marketplace:

```bash
codex plugin marketplace add <repo-or-local-path>
```

Document skills: `claude-setup`, `claude-review`, `claude-adversarial-review`, `claude-rescue`, `claude-status`, `claude-result`, `claude-cancel`.

- [ ] **Step 4: Remove app-server-only code**

Delete unused app-server/broker files and generated type config once imports/tests no longer reference them.

- [ ] **Step 5: Run cleanup test to verify green**

Run: `npm test -- tests/product-copy.test.mjs`

Expected: PASS.

- [ ] **Step 6: Full verification**

Run:

```bash
npm test
npm run build
git status --short
```

Expected: tests pass, build exits 0, git status shows only intended changes.

- [ ] **Step 7: Commit**

Run:

```bash
git add . && git commit -m "docs: document claude plugin for codex"
```
