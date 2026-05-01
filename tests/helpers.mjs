import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "claude-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

export function runChecked(command, args, options = {}) {
  const result = run(command, args, options);
  assertCommandSucceeded(command, args, result);
  return result;
}

function assertCommandSucceeded(command, args, result) {
  if (result.status === 0 && !result.error) {
    return;
  }
  const details = [
    `${command} ${args.join(" ")} failed`,
    `status: ${result.status}`,
    result.error ? `error: ${result.error.message}` : null,
    result.stdout ? `stdout:\n${result.stdout}` : null,
    result.stderr ? `stderr:\n${result.stderr}` : null
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(details);
}

export function initGitRepo(cwd) {
  runChecked("git", ["init", "-b", "main"], { cwd });
  const hooksDir = path.join(cwd, ".git", "hooks-disabled");
  fs.mkdirSync(hooksDir, { recursive: true });
  runChecked("git", ["config", "core.hooksPath", hooksDir], { cwd });
  runChecked("git", ["config", "user.name", "Claude Plugin Tests"], { cwd });
  runChecked("git", ["config", "user.email", "tests@example.com"], { cwd });
  runChecked("git", ["config", "commit.gpgsign", "false"], { cwd });
  runChecked("git", ["config", "tag.gpgsign", "false"], { cwd });
}
