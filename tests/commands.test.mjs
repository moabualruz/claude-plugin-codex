import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "claude");
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");

const EXPECTED_SKILLS = [
  ["claude-adversarial-review", "adversarial-review"],
  ["claude-cancel", "cancel"],
  ["claude-rescue", "task"],
  ["claude-result", "result"],
  ["claude-review", "review"],
  ["claude-setup", "setup"],
  ["claude-status", "status"]
];

function readSkill(name) {
  return fs.readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");
}

function frontmatterValue(source, key) {
  const match = source.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"));
  return match?.[1] ?? null;
}

test("Codex skills expose every Claude workflow wrapper", () => {
  const skillDirs = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("claude-"))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(
    skillDirs,
    EXPECTED_SKILLS.map(([name]) => name).sort()
  );
});

test("Claude skills have valid frontmatter and call claude-companion", () => {
  for (const [skillName, subcommand] of EXPECTED_SKILLS) {
    const source = readSkill(skillName);
    assert.equal(frontmatterValue(source, "name"), skillName);
    assert.match(frontmatterValue(source, "description"), /Claude/i);
    assert.match(source, /claude-companion\.mjs/);
    assert.match(source, new RegExp(`\\b${subcommand}\\b`));
    assert.doesNotMatch(source, /CLAUDE_PLUGIN_ROOT/);
    assert.doesNotMatch(source, /\/codex:/);
    assert.doesNotMatch(source, /codex-companion\.mjs/);
  }
});

test("old Claude slash commands and subagents are not shipped", () => {
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "commands")), false);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "agents")), false);
});
