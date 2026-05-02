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

test("runClaudePrompt sends prompt on stdin so variadic tool flags cannot swallow it", async () => {
  const binDir = makeTempDir("claude-plugin-runtime-");
  installFakeClaude(binDir, "stdin-required");

  const result = await runClaudePrompt(binDir, {
    prompt: "review this change",
    env: buildEnv(binDir),
    permissionMode: "default",
    disallowedTools: ["Edit", "Write", "MultiEdit"]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.finalMessage, "No material issues found.");
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

test("runClaudePrompt reports signal-terminated Claude runs as failures", async () => {
  const binDir = makeTempDir("claude-plugin-runtime-");
  installFakeClaude(binDir, "signal-terminates");

  const result = await runClaudePrompt(binDir, {
    prompt: "review this change",
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SIGTERM/);
  assert.equal(result.finalMessage, "");
});

test("parseStructuredOutput parses valid JSON and reports parse errors", () => {
  const parsed = parseStructuredOutput("{\"summary\":\"ok\",\"findings\":[]}");
  assert.deepEqual(parsed.parsed, { summary: "ok", findings: [] });
  assert.equal(parsed.parseError, null);

  const arrayOnly = parseStructuredOutput("[\"warning\"]");
  assert.deepEqual(arrayOnly.parsed, ["warning"]);
  assert.equal(arrayOnly.parseError, null);

  const objectAfterIncidentalArray = parseStructuredOutput("[\"warning\"]\n{\"summary\":\"ok\",\"findings\":[]}");
  assert.deepEqual(objectAfterIncidentalArray.parsed, { summary: "ok", findings: [] });
  assert.equal(objectAfterIncidentalArray.parseError, null);

  const correctedSecondObject = parseStructuredOutput(
    "```json\n{\"verdict\":\"needs-attention\",\"summary\":\"old\"}\n```\nCorrection:\n```json\n{\"verdict\":\"approve\",\"summary\":\"new\"}\n```"
  );
  assert.deepEqual(correctedSecondObject.parsed, { verdict: "approve", summary: "new" });
  assert.equal(correctedSecondObject.parseError, null);

  const fenced = parseStructuredOutput("```json\n{\"summary\":\"ok\",\"findings\":[]}\n```");
  assert.deepEqual(fenced.parsed, { summary: "ok", findings: [] });
  assert.equal(fenced.parseError, null);

  const fencedWithPreamble = parseStructuredOutput("Here is the result:\n```json\n{\"summary\":\"ok\"}\n```\nDone.");
  assert.deepEqual(fencedWithPreamble.parsed, { summary: "ok" });
  assert.equal(fencedWithPreamble.parseError, null);
  assert.equal(fencedWithPreamble.rawOutput, "Here is the result:\n```json\n{\"summary\":\"ok\"}\n```\nDone.");

  const bareJsonWithPreamble = parseStructuredOutput("Here is the result:\n{\"summary\":\"ok\"}");
  assert.deepEqual(bareJsonWithPreamble.parsed, { summary: "ok" });
  assert.equal(bareJsonWithPreamble.parseError, null);

  const bareJsonWithTrailingProse = parseStructuredOutput(
    "Here is the result:\n{\"summary\":\"ok\",\"note\":\"keeps } inside strings\"}\nDone."
  );
  assert.deepEqual(bareJsonWithTrailingProse.parsed, { summary: "ok", note: "keeps } inside strings" });
  assert.equal(bareJsonWithTrailingProse.parseError, null);

  const bareJsonAfterPreambleBraces = parseStructuredOutput(
    "The regex /[a-z]{3}/ is unrelated.\n{\"summary\":\"ok\"}"
  );
  assert.deepEqual(bareJsonAfterPreambleBraces.parsed, { summary: "ok" });
  assert.equal(bareJsonAfterPreambleBraces.parseError, null);

  const fencedWithBackticks = parseStructuredOutput("```json\n{\"summary\":\"mentions ```js nested fence text\"}\n```");
  assert.deepEqual(fencedWithBackticks.parsed, { summary: "mentions ```js nested fence text" });
  assert.equal(fencedWithBackticks.parseError, null);

  const fencedWithTrailingBackticks = parseStructuredOutput(
    "```json\n{\"summary\":\"ok\"}\n```\nNote: trailing prose mentions ```json schema."
  );
  assert.deepEqual(fencedWithTrailingBackticks.parsed, { summary: "ok" });
  assert.equal(fencedWithTrailingBackticks.parseError, null);

  const fencedWithTrailingFenceWhitespace = parseStructuredOutput("```json\n{\"summary\":\"ok\"}\n``` ");
  assert.deepEqual(fencedWithTrailingFenceWhitespace.parsed, { summary: "ok" });
  assert.equal(fencedWithTrailingFenceWhitespace.parseError, null);

  const secondFenceIsJson = parseStructuredOutput("```text\nnot json\n```\n```json\n{\"summary\":\"ok\"}\n```");
  assert.deepEqual(secondFenceIsJson.parsed, { summary: "ok" });
  assert.equal(secondFenceIsJson.parseError, null);

  const unrelatedJson = parseStructuredOutput("Error: config {invalid} not found {\"summary\":\"ok\"}");
  assert.equal(unrelatedJson.parsed, null);

  const invalid = parseStructuredOutput("not json", { failureMessage: "fallback" });
  assert.equal(invalid.parsed, null);
  assert.match(invalid.parseError, /Unexpected token|not valid JSON/i);
  assert.equal(invalid.failureMessage, "fallback");

  const fallbackCannotOverrideParseResult = parseStructuredOutput("{\"summary\":\"ok\"}", {
    parsed: null,
    parseError: "fallback parse error"
  });
  assert.deepEqual(fallbackCannotOverrideParseResult.parsed, { summary: "ok" });
  assert.equal(fallbackCannotOverrideParseResult.parseError, null);
});
