import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function buildEnv(binDir, extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
  };
}

export function installFakeClaude(binDir, behavior = "review-ok") {
  const scriptPath = path.join(binDir, "claude");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const BEHAVIOR = ${JSON.stringify(behavior)};

function writeJson(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function promptFromStdin() {
  try {
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("claude-code fake 1.0.0");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "auth-run-fails") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log(JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "test@example.com"
  }, null, 2));
  process.exit(0);
}

if (!args.includes("-p") && !args.includes("--print")) {
  console.error("unsupported fake claude command: " + args.join(" "));
  process.exit(1);
}

if (BEHAVIOR === "auth-run-fails") {
  console.error("not authenticated");
  process.exit(1);
}

function runPrompt() {
  const prompt = promptFromStdin();
  if (!prompt) {
    console.error("stdin prompt required");
    process.exit(1);
  }
  const outputFormatIndex = args.indexOf("--output-format");
  const outputFormat = outputFormatIndex >= 0 ? args[outputFormatIndex + 1] : "text";
  const wantsStructured = /json|structured|schema|adversarial/i.test(prompt);
  const text = wantsStructured
    ? JSON.stringify({ verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] })
    : "No material issues found.";

  if (outputFormat === "stream-json") {
    writeJson({ type: "system", subtype: "init", session_id: "fake-session-1" });
    writeJson({ type: "assistant", message: { content: [{ type: "text", text }] } });
    writeJson({ type: "result", subtype: "success", session_id: "fake-session-1", result: text });
    writeJson({ type: "summary", summary: "Inspected the requested prompt." });
    writeJson({ type: "tool_result", name: "Edit", file_path: "src/app.js" });
    process.exit(0);
  }

  console.log(text);
  process.exit(0);
}

if (BEHAVIOR === "signal-terminates") {
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => {
    process.exit(0);
  }, 5000);
} else if (BEHAVIOR === "slow") {
  setTimeout(runPrompt, 5000);
} else {
  runPrompt();
}
`;
  writeExecutable(scriptPath, source);
}
