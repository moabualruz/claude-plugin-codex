import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXTENSIONS = new Set([".json", ".md", ".mjs", ".yml", ".yaml"]);
const FORBIDDEN = [
  /Codex plugin for Claude Code/,
  /Use Codex from Claude Code/,
  /@openai\/codex-plugin-cc/,
  /\.claude-plugin/,
  /\/codex:/,
  /codex-companion\.mjs/,
  /plugins\/codex/
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".worktrees", "node_modules", ".generated"].includes(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(ROOT, fullPath);
    if (relativePath === "tests" || relativePath.startsWith(`tests${path.sep}`)) {
      continue;
    }
    if (relativePath === "docs/superpowers" || relativePath.startsWith(`docs${path.sep}superpowers${path.sep}`)) {
      continue;
    }
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

test("user-visible copy no longer describes upstream Codex-for-Claude plugin", () => {
  const offenders = [];
  for (const filePath of walk(ROOT)) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const pattern of FORBIDDEN) {
      if (pattern.test(source)) {
        offenders.push(`${path.relative(ROOT, filePath)} matches ${pattern}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});
