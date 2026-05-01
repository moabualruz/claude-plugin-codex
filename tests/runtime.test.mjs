import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeClaude } from "./fake-claude-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "claude");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "claude-companion.mjs");

function makeRepo() {
  const repo = makeTempDir("claude-plugin-repo-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");
  return repo;
}

function runCompanion(args, options = {}) {
  return run("node", [SCRIPT, ...args], {
    cwd: options.cwd ?? ROOT,
    env: options.env,
    input: options.input
  });
}

test("setup reports ready when fake Claude is installed and authenticated", () => {
  const binDir = makeTempDir("claude-plugin-bin-");
  installFakeClaude(binDir);
  const repo = makeRepo();

  const result = runCompanion(["setup", "--json", "--cwd", repo], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.claude.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("review runs Claude read-only against working tree", () => {
  const binDir = makeTempDir("claude-plugin-bin-");
  installFakeClaude(binDir);
  const repo = makeRepo();

  const result = runCompanion(["review", "--json", "--cwd", repo], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Review");
  assert.equal(payload.claude.status, 0);
  assert.match(payload.claude.stdout, /No material issues found/);
});

test("adversarial review renders structured Claude findings", () => {
  const binDir = makeTempDir("claude-plugin-bin-");
  installFakeClaude(binDir);
  const repo = makeRepo();

  const result = runCompanion(["adversarial-review", "--json", "--cwd", repo, "challenge risk"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Adversarial Review");
  assert.equal(payload.result.summary, "No material issues found.");
});

test("task can run foreground and stores result for status/result", () => {
  const binDir = makeTempDir("claude-plugin-bin-");
  installFakeClaude(binDir);
  const repo = makeRepo();
  const env = buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: makeTempDir("claude-plugin-data-")
  });

  const task = runCompanion(["task", "--json", "--cwd", repo, "inspect this repo"], {
    cwd: repo,
    env
  });
  assert.equal(task.status, 0, task.stderr);
  const taskPayload = JSON.parse(task.stdout);
  assert.match(taskPayload.rawOutput, /No material issues found/);

  const status = runCompanion(["status", "--json", "--cwd", repo], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.latestFinished.status, "completed");

  const result = runCompanion(["result", "--json", "--cwd", repo], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal(resultPayload.job.id, statusPayload.latestFinished.id);
  assert.match(resultPayload.storedJob.rendered, /No material issues found/);
});

test("background task can be cancelled", () => {
  const binDir = makeTempDir("claude-plugin-bin-");
  installFakeClaude(binDir, "slow");
  const repo = makeRepo();
  const env = buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: makeTempDir("claude-plugin-data-")
  });

  const task = runCompanion(["task", "--json", "--background", "--cwd", repo, "inspect slowly"], {
    cwd: repo,
    env
  });
  assert.equal(task.status, 0, task.stderr);
  const taskPayload = JSON.parse(task.stdout);

  const cancel = runCompanion(["cancel", "--json", "--cwd", repo, taskPayload.jobId], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  const cancelPayload = JSON.parse(cancel.stdout);
  assert.equal(cancelPayload.status, "cancelled");
});
