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
  const { prompt: _prompt, defaultPrompt: _defaultPrompt, ...argOptions } = options;
  const args = buildClaudeArgs({
    ...argOptions,
    outputFormat
  });

  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let stdinError = null;
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    try {
      child.stdin.end(prompt);
    } catch (error) {
      stdinError = error;
    }
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
    child.on("close", (status, signal) => {
      const childStatus = status ?? (signal ? 1 : 0);
      const normalizedStatus = childStatus !== 0 ? childStatus : (stdinError ? 1 : 0);
      const shouldReportStdinError = childStatus === 0 && stdinError;
      const normalizedStderr = [
        stderr,
        signal ? `Claude process exited after signal ${signal}.` : "",
        shouldReportStdinError ? `Failed to write prompt to Claude stdin: ${stdinError.message}` : ""
      ]
        .filter(Boolean)
        .join("\n");
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
        status: normalizedStatus,
        threadId: parsed.threadId,
        turnId: null,
        finalMessage: normalizedStatus === 0 ? parsed.finalMessage : "",
        reasoningSummary: parsed.reasoningSummary,
        stderr: normalizedStderr,
        stdout,
        touchedFiles: parsed.touchedFiles,
        commandExecutions: [],
        fileChanges: parsed.touchedFiles.map((filePath) => ({
          type: "fileChange",
          changes: [{ path: filePath }]
        })),
        error:
          normalizedStatus === 0
            ? null
            : new Error(normalizedStderr.trim() || `Claude exited with status ${normalizedStatus}`)
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
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Claude did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }

  const candidates = buildStructuredOutputCandidates(rawOutput);
  let parseError = null;
  const parsedCandidates = [];
  for (const candidate of candidates) {
    try {
      parsedCandidates.push(JSON.parse(candidate));
    } catch (error) {
      parseError ??= error instanceof Error ? error.message : String(error);
    }
  }

  const objectCandidates = parsedCandidates.filter((parsed) => isPlainObject(parsed));
  const preferred = lastValue(objectCandidates) ?? lastValue(parsedCandidates);
  if (preferred) {
    return {
      ...fallback,
      parsed: preferred,
      parseError: null,
      rawOutput
    };
  }

  return {
    ...fallback,
    parsed: null,
    parseError,
    rawOutput
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lastValue(values) {
  return values.length > 0 ? values[values.length - 1] : null;
}

function buildStructuredOutputCandidates(rawOutput) {
  const trimmed = String(rawOutput ?? "").trim();
  const candidates = [];
  addCandidate(candidates, trimmed);

  addBareJsonCandidates(candidates, trimmed);
  addFencedCandidates(candidates, trimmed);

  return candidates;
}

function addBareJsonCandidates(candidates, text) {
  const lineStartPattern = /(?:^|\r?\n)\s*[\[{]/g;
  let match;
  while ((match = lineStartPattern.exec(text)) !== null) {
    const jsonStart = match.index + (match[0].startsWith("\n") || match[0].startsWith("\r\n") ? match[0].search(/[\[{]/) : 0);
    const candidate = text.slice(jsonStart).trim();
    const extracted = extractJsonPrefix(candidate);
    if (extracted) {
      addCandidate(candidates, extracted);
    }
  }
}

function extractJsonPrefix(value) {
  const text = String(value ?? "").trim();
  const first = text[0];
  if (first !== "{" && first !== "[") {
    return null;
  }

  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const opener = stack.pop();
      if ((char === "}" && opener !== "{") || (char === "]" && opener !== "[")) {
        return null;
      }
      if (stack.length === 0) {
        return text.slice(0, index + 1).trim();
      }
    }
  }

  return null;
}

function addFencedCandidates(candidates, text) {
  const openerPattern = /```[^\r\n]*(?:\r?\n)/g;
  let opener;
  while ((opener = openerPattern.exec(text)) !== null) {
    const contentStart = opener.index + opener[0].length;
    const tail = text.slice(contentStart);
    const closer = /\r?\n```\s*(?:\r?\n|$)/.exec(tail);
    if (!closer) {
      openerPattern.lastIndex = contentStart;
      continue;
    }
    addCandidate(candidates, tail.slice(0, closer.index).trim());
    openerPattern.lastIndex = contentStart + closer.index + closer[0].length;
  }
}

function addCandidate(candidates, value) {
  if (value && !candidates.includes(value)) {
    candidates.push(value);
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
