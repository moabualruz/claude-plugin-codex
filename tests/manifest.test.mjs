import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("repo exposes a Codex marketplace and Claude plugin manifest", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".agents", "plugins", "marketplace.json"), "utf8")
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "plugins", "claude", ".codex-plugin", "plugin.json"), "utf8")
  );

  assert.equal(marketplace.name, "claude-code");
  assert.equal(marketplace.plugins[0].name, "claude");
  assert.deepEqual(marketplace.plugins[0].source, { source: "local", path: "./plugins/claude" });
  assert.equal(manifest.name, "claude");
  assert.match(manifest.description, /Claude Code from Codex/i);
});
