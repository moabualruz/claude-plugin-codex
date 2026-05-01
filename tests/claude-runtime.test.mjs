import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeClaude } from "./fake-claude-fixture.mjs";
import {
  getClaudeAuthStatus,
  getClaudeAvailability,
  parseStructuredOutput,
  runClaudePrompt
} from "../plugins/claude/scripts/lib/claude.mjs";

test("setup reports fake Claude availability and auth", async () => {
  const binDir = makeTempDir("claude-plugin-runtime-");
  installFakeClaude(binDir);
  const env = buildEnv(binDir);

  const availability = getClaudeAvailability(binDir, { env });
  const auth = await getClaudeAuthStatus(binDir, { env });

  assert.equal(availability.available, true);
  assert.match(availability.detail, /claude-code fake/i);
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.authMethod, "claude.ai");
  assert.equal(auth.source, "claude auth status");
});

test("runClaudePrompt parses stream-json assistant and result output", async () => {
  const binDir = makeTempDir("claude-plugin-runtime-");
  installFakeClaude(binDir, "review-ok");

  const result = await runClaudePrompt(binDir, {
    prompt: "review this change",
    env: buildEnv(binDir),
    permissionMode: "default"
  });

  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "No material issues found.");
  assert.equal(result.threadId, "fake-session-1");
  assert.deepEqual(result.reasoningSummary, ["Inspected the requested prompt."]);
  assert.deepEqual(result.touchedFiles, ["src/app.js"]);
});

test("runClaudePrompt returns nonzero status and stderr on auth failure", async () => {
  const binDir = makeTempDir("claude-plugin-runtime-");
  installFakeClaude(binDir, "auth-run-fails");

  const result = await runClaudePrompt(binDir, {
    prompt: "review this change",
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not authenticated/i);
  assert.equal(result.finalMessage, "");
});

test("parseStructuredOutput parses valid JSON and reports parse errors", () => {
  const parsed = parseStructuredOutput("{\"summary\":\"ok\",\"findings\":[]}");
  assert.deepEqual(parsed.parsed, { summary: "ok", findings: [] });
  assert.equal(parsed.parseError, null);

  const invalid = parseStructuredOutput("not json", { failureMessage: "fallback" });
  assert.equal(invalid.parsed, null);
  assert.match(invalid.parseError, /Unexpected token|not valid JSON/i);
  assert.equal(invalid.failureMessage, "fallback");
});
