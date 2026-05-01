import { spawn } from "node:child_process";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";

const TASK_THREAD_PREFIX = "Claude Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

function asText(value) {
  return String(value ?? "").trim();
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function collectTextFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry?.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function addUnique(values, value) {
  const normalized = normalizeReasoningText(value);
  if (normalized && !values.includes(normalized)) {
    values.push(normalized);
  }
}

function collectTouchedFile(files, value) {
  const filePath =
    value?.file_path ??
    value?.filePath ??
    value?.path ??
    value?.input?.file_path ??
    value?.input?.filePath ??
    value?.input?.path ??
    null;
  if (typeof filePath === "string" && filePath && !files.includes(filePath)) {
    files.push(filePath);
  }
}

function parseClaudeStream(stdout) {
  const messages = [];
  const reasoningSummary = [];
  const touchedFiles = [];
  let threadId = null;
  let finalMessage = "";

  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      messages.push(line);
      continue;
    }

    threadId = event.session_id ?? event.sessionId ?? event.message?.session_id ?? threadId;

    if (event.type === "assistant") {
      const text = collectTextFromContent(event.message?.content ?? event.content);
      if (text) {
        messages.push(text);
        finalMessage = text;
      }
    } else if (event.type === "result") {
      const text = asText(event.result);
      if (text) {
        finalMessage = text;
      }
    } else if (event.type === "summary") {
      addUnique(reasoningSummary, event.summary ?? event.text);
    } else if (event.type === "system" && event.subtype === "init") {
      threadId = event.session_id ?? threadId;
    } else if (event.type === "tool_use" || event.type === "tool_result") {
      collectTouchedFile(touchedFiles, event);
    }
  }

  return {
    finalMessage,
    reasoningSummary,
    touchedFiles,
    threadId,
    messages
  };
}

function buildClaudeArgs(options = {}) {
  const args = ["-p", "--output-format", options.outputFormat ?? "stream-json"];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.allowedTools?.length) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (options.disallowedTools?.length) {
    args.push("--disallowedTools", options.disallowedTools.join(","));
  }
  args.push(options.prompt);
  return args;
}

export function getClaudeAvailability(cwd, options = {}) {
  return binaryAvailable("claude", ["--version"], {
    cwd,
    env: options.env
  });
}

export async function getClaudeAuthStatus(cwd, options = {}) {
  const availability = getClaudeAvailability(cwd, options);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null
    };
  }

  return new Promise((resolve) => {
    const child = spawn("claude", ["auth", "status", "--json"], {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        available: true,
        loggedIn: false,
        detail: error.message,
        source: "claude auth status",
        authMethod: null,
        verified: false
      });
    });
    child.on("close", (status) => {
      if (status !== 0) {
        resolve({
          available: true,
          loggedIn: false,
          detail: stderr.trim() || stdout.trim() || `exit ${status}`,
          source: "claude auth status",
          authMethod: null,
          verified: true
        });
        return;
      }

      try {
        const payload = JSON.parse(stdout);
        resolve({
          available: true,
          loggedIn: Boolean(payload.loggedIn),
          detail: payload.loggedIn ? "authenticated" : "not authenticated",
          source: "claude auth status",
          authMethod: payload.authMethod ?? null,
          verified: true,
          account: payload
        });
      } catch (error) {
        resolve({
          available: true,
          loggedIn: false,
          detail: error instanceof Error ? error.message : String(error),
          source: "claude auth status",
          authMethod: null,
          verified: true
        });
      }
    });
  });
}

export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "direct startup",
    detail: "Claude Code runs are launched directly through the local Claude CLI.",
    endpoint: null
  };
}

export async function runClaudePrompt(cwd, options = {}) {
  const prompt = asText(options.prompt ?? options.defaultPrompt);
  if (!prompt) {
    throw new Error("A prompt is required for this Claude run.");
  }

  const outputFormat = options.outputFormat ?? "stream-json";
  const args = buildClaudeArgs({
    ...options,
    outputFormat,
    prompt
  });

  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        status: 1,
        threadId: null,
        turnId: null,
        finalMessage: "",
        reasoningSummary: [],
        stderr: error.message,
        stdout: "",
        touchedFiles: [],
        commandExecutions: [],
        fileChanges: [],
        error
      });
    });
    child.on("close", (status) => {
      const parsed =
        outputFormat === "stream-json"
          ? parseClaudeStream(stdout)
          : {
              finalMessage: stdout.trim(),
              reasoningSummary: [],
              touchedFiles: [],
              threadId: null,
              messages: stdout.trim() ? [stdout.trim()] : []
            };
      resolve({
        status: status ?? 0,
        threadId: parsed.threadId,
        turnId: null,
        finalMessage: status === 0 ? parsed.finalMessage : "",
        reasoningSummary: parsed.reasoningSummary,
        stderr,
        stdout,
        touchedFiles: parsed.touchedFiles,
        commandExecutions: [],
        fileChanges: parsed.touchedFiles.map((filePath) => ({
          type: "fileChange",
          changes: [{ path: filePath }]
        })),
        error: status === 0 ? null : new Error(stderr.trim() || `Claude exited with status ${status}`)
      });
    });
  });
}

export async function interruptClaudeRun() {
  return {
    attempted: false,
    interrupted: false,
    transport: null,
    detail: "Claude Code does not expose a stable external turn interrupt API."
  };
}

export async function findLatestTaskThread() {
  return null;
}

export function buildPersistentTaskThreadName(prompt) {
  const normalized = asText(prompt).replace(/\s+/g, " ");
  const excerpt = normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Claude did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error instanceof Error ? error.message : String(error),
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
