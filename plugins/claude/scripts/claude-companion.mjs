#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  DEFAULT_CONTINUE_PROMPT,
  buildPersistentTaskThreadName,
  findLatestTaskThread,
  getClaudeAuthStatus,
  getClaudeAvailability,
  getSessionRuntimeStatus,
  interruptClaudeRun,
  parseStructuredOutput,
  readOutputSchema,
  runClaudePrompt
} from "./lib/claude.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { generateJobId, getConfig, listJobs, setConfig, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Codex turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/claude-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/claude-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/claude-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/claude-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/claude-companion.mjs status [job-id] [--wait] [--all] [--json]",
      "  node scripts/claude-companion.mjs result [job-id] [--json]",
      "  node scripts/claude-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(String(value));
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    return raw?.trim() ? splitRawArgumentString(raw) : [];
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(`Unsupported Claude effort "${effort}". Use one of: low, medium, high, xhigh, max.`);
  }
  return normalized;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean) ?? fallback
  );
}

function renderSetupReport(report) {
  const lines = [
    "# Claude Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- claude: ${report.claude.detail}`,
    `- auth: ${report.auth.detail}`,
    `- runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`
  ];
  if (report.actionsTaken.length > 0) {
    lines.push("", "Actions taken:", ...report.actionsTaken.map((action) => `- ${action}`));
  }
  if (report.nextSteps.length > 0) {
    lines.push("", "Next steps:", ...report.nextSteps.map((step) => `- ${step}`));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderPlainResult(title, body) {
  return `# ${title}\n\n${String(body ?? "").trim() || "No output."}\n`;
}

function renderStatusTable(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const claudeStatus = getClaudeAvailability(cwd);
  const authStatus = await getClaudeAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!claudeStatus.available) {
    nextSteps.push("Install Claude Code with `npm install -g @anthropic-ai/claude-code`.");
  }
  if (claudeStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `!claude auth login`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `claude-setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && claudeStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    claude: claudeStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];
  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const report = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function ensureClaudeAvailable(cwd) {
  const availability = getClaudeAvailability(cwd);
  if (!availability.available) {
    throw new Error("Claude Code is not installed. Install it with `npm install -g @anthropic-ai/claude-code`, then rerun `claude-setup`.");
  }
}

function buildNormalReviewPrompt(context) {
  return [
    "You are performing a read-only code review for Codex.",
    "Find bugs, regressions, unsafe behavior, and missing tests. Findings first, ordered by severity.",
    `Target: ${context.target.label}`,
    "",
    context.content
  ].join("\n");
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

async function executeReviewRun(request) {
  ensureClaudeAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const context = collectReviewContext(request.cwd, target);
  const reviewName = request.reviewName ?? "Review";
  const prompt =
    reviewName === "Adversarial Review"
      ? buildAdversarialReviewPrompt(context, request.focusText?.trim() ?? "")
      : buildNormalReviewPrompt(context);
  const result = await runClaudePrompt(context.repoRoot, {
    prompt,
    model: request.model,
    permissionMode: "default",
    disallowedTools: ["Edit", "Write", "MultiEdit"],
    outputSchema: reviewName === "Adversarial Review" ? readOutputSchema(REVIEW_SCHEMA) : null,
    onProgress: request.onProgress
  });

  const parsed =
    reviewName === "Adversarial Review"
      ? parseStructuredOutput(result.finalMessage, {
          status: result.status,
          failureMessage: result.error?.message ?? result.stderr
        })
      : null;
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    claude: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    ...(parsed
      ? {
          result: parsed.parsed,
          rawOutput: parsed.rawOutput,
          parseError: parsed.parseError,
          reasoningSummary: result.reasoningSummary
        }
      : {})
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderPlainResult(`Claude ${reviewName}`, result.finalMessage || result.stderr),
    summary:
      parsed?.parsed?.summary ??
      parsed?.parseError ??
      firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Claude ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const activeTask = jobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use claude-status before continuing it.`);
  }
  const trackedTask = jobs.find((job) => job.jobClass === "task" && job.threadId && job.status !== "queued" && job.status !== "running");
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }
  return findLatestTaskThread(workspaceRoot);
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Claude Stop Gate Review",
      summary: "Stop-gate review of previous Codex turn"
    };
  }

  const title = resumeLast ? "Claude Resume" : "Claude Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureClaudeAvailable(request.cwd);

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Claude task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runClaudePrompt(workspaceRoot, {
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    permissionMode: request.write ? "acceptEdits" : "default",
    disallowedTools: request.write ? [] : ["Edit", "Write", "MultiEdit"],
    onProgress: request.onProgress
  });
  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });
  const rendered = renderPlainResult(taskMetadata.title, rawOutput || failureMessage);
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedWorker(cwd, subcommand, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "claude-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, subcommand, "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundJob(cwd, job, request, workerSubcommand) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");
  const child = spawnDetachedWorker(cwd, workerSubcommand, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

function renderQueuedLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check claude-status ${payload.jobId} for progress.\n`;
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Claude Review" : `Claude ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  const request = {
    cwd,
    base: options.base,
    scope: options.scope,
    model: options.model,
    focusText,
    reviewName: config.reviewName,
    jobId: job.id
  };
  if (options.background) {
    ensureClaudeAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request, "review-worker");
    outputCommandResult(payload, renderQueuedLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  return positionals.join(" ") || readStdinIfPiped();
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: { m: "model" }
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  const request = {
    cwd,
    model: options.model ?? null,
    effort,
    prompt,
    write,
    resumeLast,
    jobId: job.id
  };
  if (options.background) {
    ensureClaudeAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request, "task-worker");
    outputCommandResult(payload, renderQueuedLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeTaskRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function runWorker(argv, runner) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for worker.");
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );
  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () => runner({ ...storedJob.request, onProgress: progress }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderStatusTable(snapshot), options.json);
    return;
  }
  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }
  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusTable(report), options.json);
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);
  while ((snapshot.job.status === "queued" || snapshot.job.status === "running") && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }
  return {
    ...snapshot,
    waitTimedOut: snapshot.job.status === "queued" || snapshot.job.status === "running",
    timeoutMs
  };
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };
  outputCommandResult(payload, storedJob?.rendered ?? renderStatusTable(payload), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const candidate = jobs.find((job) => job.jobClass === "task" && job.threadId && job.status !== "queued" && job.status !== "running");
  const payload = {
    available: Boolean(candidate),
    sessionId: process.env[SESSION_ID_ENV] ?? null,
    candidate: candidate
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title ?? null,
          summary: candidate.summary ?? null,
          threadId: candidate.threadId,
          completedAt: candidate.completedAt ?? null,
          updatedAt: candidate.updatedAt ?? null
        }
      : null
  };
  outputCommandResult(payload, candidate ? `Resumable task found: ${candidate.id}\n` : "No resumable task found.\n", options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const interrupt = await interruptClaudeRun(cwd, { sessionId: existing.threadId ?? job.threadId ?? null });
  if (interrupt.attempted) {
    appendLogLine(job.logFile, interrupt.interrupted ? "Requested Claude interruption." : `Claude interruption failed: ${interrupt.detail}`);
  }
  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");
  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };
  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });
  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };
  outputCommandResult(payload, `Cancelled ${job.id}.\n`, options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review" });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "review-worker":
      await runWorker(argv, executeReviewRun);
      break;
    case "task-worker":
      await runWorker(argv, executeTaskRun);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
