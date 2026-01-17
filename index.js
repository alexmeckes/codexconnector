#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "child_process";
import { mkdir, readFile, writeFile, readdir, appendFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { createWriteStream, existsSync } from "fs";
import { randomUUID } from "crypto";

// Find codex binary path at startup
const CODEX_PATH = (() => {
  try {
    return execSync("which codex", { encoding: "utf-8" }).trim();
  } catch {
    return "codex";
  }
})();

// Logs and state directory
const DATA_DIR = join(homedir(), ".codex-connector");
const LOGS_DIR = join(DATA_DIR, "logs");
const TASKS_FILE = join(DATA_DIR, "tasks.json");

// In-memory task tracking (also persisted to disk)
const tasks = new Map();

// Active process handles (for running tasks)
const activeProcesses = new Map();

// Initialize directories
async function initDirs() {
  await mkdir(LOGS_DIR, { recursive: true });
  // Load existing tasks from disk
  try {
    const data = await readFile(TASKS_FILE, "utf-8");
    const savedTasks = JSON.parse(data);
    for (const [id, task] of Object.entries(savedTasks)) {
      // Mark any "running" tasks from previous sessions as "unknown"
      if (task.status === "running") {
        task.status = "interrupted";
        task.failureReason = "Server restarted while task was running";
      }
      tasks.set(id, task);
    }
  } catch {
    // No existing tasks file
  }
}

async function saveTasks() {
  const obj = Object.fromEntries(tasks);
  await writeFile(TASKS_FILE, JSON.stringify(obj, null, 2));
}

// Format duration in human readable form
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

// Signal name mapping
const SIGNALS = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  14: "SIGALRM",
  15: "SIGTERM",
};

function getSignalName(code) {
  if (code === null) return null;
  if (code > 128) {
    const signal = code - 128;
    return SIGNALS[signal] || `signal ${signal}`;
  }
  return null;
}

// Default model and reasoning settings
const DEFAULT_MODEL = "gpt-5.2-codex";
const DEFAULT_REASONING_EFFORT = "high";

const server = new Server(
  {
    name: "codex-connector",
    version: "1.4.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {}, // Enable logging for progress notifications
    },
  }
);

// Helper to send progress notifications to Claude
async function sendProgress(taskId, message, data = {}) {
  try {
    await server.sendLoggingMessage({
      level: "info",
      logger: "codex-connector",
      data: {
        taskId,
        message,
        timestamp: new Date().toISOString(),
        ...data,
      },
    });
  } catch (err) {
    // Ignore notification errors - client may not support logging
  }
}

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "codex_agent",
        description:
          "Spawn an OpenAI Codex agent to handle a coding task. By default waits for completion. Set async=true for long-running tasks to get a task ID immediately.",
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "The task or prompt to send to Codex",
            },
            sandbox: {
              type: "string",
              enum: ["read-only", "workspace-write", "danger-full-access"],
              description: "Permission level. Defaults to danger-full-access.",
              default: "danger-full-access",
            },
            workingDirectory: {
              type: "string",
              description: "Working directory for Codex. REQUIRED.",
            },
            model: {
              type: "string",
              description: "Model to use. Defaults to gpt-5.2-codex.",
              default: "gpt-5.2-codex",
            },
            reasoningEffort: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Reasoning effort level. Defaults to high.",
              default: "high",
            },
            async: {
              type: "boolean",
              description:
                "If true, returns immediately with task ID. Use codex_status to check progress. Recommended for long-running tasks.",
              default: false,
            },
            timeoutMs: {
              type: "number",
              description: "Timeout in ms. 0 = no timeout (default).",
              default: 0,
            },
          },
          required: ["task", "workingDirectory"],
        },
      },
      {
        name: "codex_status",
        description:
          "Check the status of a Codex task. Returns status, logs, diagnostics, and result if completed.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The task ID returned by codex_agent",
            },
            tailLines: {
              type: "number",
              description: "Number of recent log lines to return (default 50)",
              default: 50,
            },
          },
          required: ["taskId"],
        },
      },
      {
        name: "codex_tasks",
        description: "List all Codex tasks (running and completed)",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["all", "running", "completed", "failed", "interrupted"],
              description: "Filter by status (default: all)",
              default: "all",
            },
            limit: {
              type: "number",
              description: "Max tasks to return (default 20)",
              default: 20,
            },
          },
        },
      },
      {
        name: "codex_cancel",
        description: "Cancel a running Codex task",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The task ID to cancel",
            },
          },
          required: ["taskId"],
        },
      },
      {
        name: "codex_wait",
        description:
          "Wait for a Codex task to complete. Blocks until the task finishes, then returns the full result. Useful for subagents monitoring async tasks.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The task ID to wait for",
            },
            pollIntervalMs: {
              type: "number",
              description: "How often to check status in ms (default: 5000)",
              default: 5000,
            },
            timeoutMs: {
              type: "number",
              description: "Max time to wait in ms. 0 = no timeout (default).",
              default: 0,
            },
          },
          required: ["taskId"],
        },
      },
    ],
  };
});

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "codex_agent":
        return await handleCodexAgent(args);
      case "codex_status":
        return await handleCodexStatus(args);
      case "codex_tasks":
        return await handleCodexTasks(args);
      case "codex_cancel":
        return await handleCodexCancel(args);
      case "codex_wait":
        return await handleCodexWait(args);
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function handleCodexAgent(args) {
  const taskId = randomUUID().slice(0, 8);
  const task = args.task;
  const sandbox = args.sandbox || "danger-full-access";
  const workingDirectory = args.workingDirectory;
  const model = args.model || DEFAULT_MODEL;
  const reasoningEffort = args.reasoningEffort || DEFAULT_REASONING_EFFORT;
  const asyncMode = args.async || false;
  const timeoutMs = args.timeoutMs || 0;

  const logFile = join(LOGS_DIR, `${taskId}.log`);
  const resultFile = join(LOGS_DIR, `${taskId}.result`);
  const debugFile = join(LOGS_DIR, `${taskId}.debug.json`);

  // Build the codex command
  const codexArgs = [
    "exec",
    "--full-auto",
    "--model",
    model,
    "-c",
    `reasoning_effort="${reasoningEffort}"`,
    "--sandbox",
    sandbox,
    "--output-last-message",
    resultFile,
    task,
  ];

  const fullCommand = `${CODEX_PATH} ${codexArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;

  // Create task record with enhanced debugging info
  const taskRecord = {
    id: taskId,
    task,
    sandbox,
    workingDirectory,
    model,
    reasoningEffort,
    status: "running",
    startedAt: new Date().toISOString(),
    logFile,
    resultFile,
    debugFile,
    pid: null,
    // Debug info
    command: fullCommand,
    codexPath: CODEX_PATH,
    stdoutBytes: 0,
    stderrBytes: 0,
    lastActivityAt: new Date().toISOString(),
    lastActivityType: "started",
    lastOutputSnippet: "",
    heartbeatCount: 0,
    timeoutMs,
    // Failure tracking
    exitCode: null,
    exitSignal: null,
    failureReason: null,
  };
  tasks.set(taskId, taskRecord);
  await saveTasks();

  // Write initial debug info
  await writeFile(debugFile, JSON.stringify({
    taskId,
    command: fullCommand,
    codexPath: CODEX_PATH,
    workingDirectory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "(set)" : "(not set)",
    },
    startedAt: taskRecord.startedAt,
  }, null, 2));

  const logStream = createWriteStream(logFile, { flags: "a" });

  // Enhanced logging header
  await appendFile(logFile, `${"=".repeat(60)}\n`);
  await appendFile(logFile, `[${new Date().toISOString()}] TASK STARTED\n`);
  await appendFile(logFile, `${"=".repeat(60)}\n`);
  await appendFile(logFile, `Task ID: ${taskId}\n`);
  await appendFile(logFile, `Command: ${fullCommand}\n`);
  await appendFile(logFile, `Working directory: ${workingDirectory}\n`);
  await appendFile(logFile, `Sandbox: ${sandbox}\n`);
  await appendFile(logFile, `Model: ${model}\n`);
  await appendFile(logFile, `Reasoning effort: ${reasoningEffort}\n`);
  await appendFile(logFile, `Timeout: ${timeoutMs > 0 ? `${timeoutMs}ms` : "none"}\n`);
  await appendFile(logFile, `${"=".repeat(60)}\n\n`);

  // Send initial progress notification
  await sendProgress(taskId, "Codex task started", {
    status: "running",
    task: task.slice(0, 100),
  });

  const codex = spawn(CODEX_PATH, codexArgs, {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  taskRecord.pid = codex.pid;
  activeProcesses.set(taskId, codex);
  await appendFile(logFile, `[${new Date().toISOString()}] Process spawned with PID ${codex.pid}\n\n`);
  await saveTasks();

  // Track activity and bytes
  const updateActivity = (type, bytes = 0, snippet = "") => {
    taskRecord.lastActivityAt = new Date().toISOString();
    taskRecord.lastActivityType = type;
    if (type === "stdout") taskRecord.stdoutBytes += bytes;
    if (type === "stderr") taskRecord.stderrBytes += bytes;
    if (snippet) {
      // Keep last meaningful output snippet for progress updates
      const cleaned = snippet.toString().trim().slice(-200);
      if (cleaned.length > 10) {
        taskRecord.lastOutputSnippet = cleaned;
      }
    }
  };

  // Stream output to log file with activity tracking
  codex.stdout.on("data", (data) => {
    logStream.write(data);
    updateActivity("stdout", data.length, data);
  });

  codex.stderr.on("data", (data) => {
    logStream.write(`[stderr] ${data}`);
    updateActivity("stderr", data.length, data);
  });

  // Heartbeat logging for long-running tasks - sends progress to Claude
  const heartbeatInterval = setInterval(async () => {
    if (taskRecord.status !== "running") {
      clearInterval(heartbeatInterval);
      return;
    }

    taskRecord.heartbeatCount++;
    const elapsed = Date.now() - new Date(taskRecord.startedAt).getTime();
    const lastActivity = Date.now() - new Date(taskRecord.lastActivityAt).getTime();

    const heartbeatMsg = `[${new Date().toISOString()}] HEARTBEAT #${taskRecord.heartbeatCount}: ` +
      `elapsed=${formatDuration(elapsed)}, ` +
      `lastActivity=${formatDuration(lastActivity)} ago (${taskRecord.lastActivityType}), ` +
      `stdout=${taskRecord.stdoutBytes}B, stderr=${taskRecord.stderrBytes}B\n`;

    await appendFile(logFile, heartbeatMsg);

    // Send progress notification to Claude
    await sendProgress(taskId, `Task still running (${formatDuration(elapsed)} elapsed)`, {
      status: "running",
      elapsed: formatDuration(elapsed),
      heartbeat: taskRecord.heartbeatCount,
      stdoutBytes: taskRecord.stdoutBytes,
      stderrBytes: taskRecord.stderrBytes,
      lastActivity: `${formatDuration(lastActivity)} ago`,
      lastActivityType: taskRecord.lastActivityType,
      recentOutput: taskRecord.lastOutputSnippet.slice(-100),
    });

    // Warn if no activity for 2+ minutes
    if (lastActivity > 120000) {
      await appendFile(logFile, `[${new Date().toISOString()}] WARNING: No activity for ${formatDuration(lastActivity)}\n`);
      await sendProgress(taskId, `Warning: No activity for ${formatDuration(lastActivity)}`, {
        status: "possibly_stalled",
        elapsed: formatDuration(elapsed),
        lastActivity: formatDuration(lastActivity),
      });
    }

    await saveTasks();
  }, 30000); // Every 30 seconds

  // Set up timeout if specified
  let timeout = null;
  if (timeoutMs > 0) {
    timeout = setTimeout(async () => {
      const elapsed = Date.now() - new Date(taskRecord.startedAt).getTime();
      taskRecord.failureReason = `Timeout after ${formatDuration(elapsed)} (limit: ${formatDuration(timeoutMs)})`;

      await appendFile(logFile, `\n${"!".repeat(60)}\n`);
      await appendFile(logFile, `[${new Date().toISOString()}] TIMEOUT: Killing process after ${formatDuration(timeoutMs)}\n`);
      await appendFile(logFile, `${"!".repeat(60)}\n`);

      await sendProgress(taskId, `Task timeout - killing process`, {
        status: "timeout",
        elapsed: formatDuration(elapsed),
        limit: formatDuration(timeoutMs),
      });

      codex.kill("SIGTERM");
      setTimeout(() => {
        if (taskRecord.status === "running") {
          codex.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);
  }

  // Handle completion
  const completionPromise = new Promise((resolve) => {
    codex.on("close", async (code, signal) => {
      clearInterval(heartbeatInterval);
      if (timeout) clearTimeout(timeout);
      activeProcesses.delete(taskId);

      const endTime = new Date().toISOString();
      const elapsed = Date.now() - new Date(taskRecord.startedAt).getTime();

      // Determine failure reason
      let failureReason = taskRecord.failureReason; // May already be set by timeout
      const signalName = signal || getSignalName(code);

      if (!failureReason) {
        if (signal) {
          failureReason = `Killed by signal: ${signal}`;
        } else if (signalName && code !== 0) {
          failureReason = `Killed by ${signalName} (exit code ${code})`;
        } else if (code !== 0) {
          failureReason = `Exited with code ${code}`;
        }
      }

      // Write detailed exit info
      await appendFile(logFile, `\n${"=".repeat(60)}\n`);
      await appendFile(logFile, `[${endTime}] TASK ${code === 0 ? "COMPLETED" : "FAILED"}\n`);
      await appendFile(logFile, `${"=".repeat(60)}\n`);
      await appendFile(logFile, `Exit code: ${code}\n`);
      await appendFile(logFile, `Exit signal: ${signal || signalName || "none"}\n`);
      await appendFile(logFile, `Duration: ${formatDuration(elapsed)}\n`);
      await appendFile(logFile, `Total stdout: ${taskRecord.stdoutBytes} bytes\n`);
      await appendFile(logFile, `Total stderr: ${taskRecord.stderrBytes} bytes\n`);
      await appendFile(logFile, `Heartbeats: ${taskRecord.heartbeatCount}\n`);
      if (failureReason) {
        await appendFile(logFile, `Failure reason: ${failureReason}\n`);
      }
      await appendFile(logFile, `${"=".repeat(60)}\n`);

      logStream.end();

      // Read result file
      let result = null;
      try {
        result = await readFile(resultFile, "utf-8");
        await appendFile(logFile, `\nResult file found (${result.length} bytes)\n`);
      } catch (err) {
        await appendFile(logFile, `\nNo result file: ${err.code}\n`);
      }

      // Update task record
      taskRecord.status = code === 0 ? "completed" : "failed";
      taskRecord.exitCode = code;
      taskRecord.exitSignal = signal || signalName;
      taskRecord.completedAt = endTime;
      taskRecord.duration = elapsed;
      taskRecord.durationFormatted = formatDuration(elapsed);
      taskRecord.result = result;
      taskRecord.pid = null;
      if (failureReason) taskRecord.failureReason = failureReason;

      // Send completion notification
      await sendProgress(taskId, `Task ${code === 0 ? "completed" : "failed"}`, {
        status: taskRecord.status,
        duration: formatDuration(elapsed),
        exitCode: code,
        exitSignal: taskRecord.exitSignal,
        failureReason,
      });

      // Update debug file
      await writeFile(debugFile, JSON.stringify(taskRecord, null, 2));
      await saveTasks();

      resolve({
        status: taskRecord.status,
        exitCode: code,
        exitSignal: taskRecord.exitSignal,
        duration: elapsed,
        durationFormatted: formatDuration(elapsed),
        failureReason,
        result,
      });
    });

    codex.on("error", async (err) => {
      clearInterval(heartbeatInterval);
      if (timeout) clearTimeout(timeout);
      activeProcesses.delete(taskId);

      const endTime = new Date().toISOString();
      const elapsed = Date.now() - new Date(taskRecord.startedAt).getTime();
      const failureReason = `Process error: ${err.message} (${err.code || "unknown"})`;

      await appendFile(logFile, `\n${"!".repeat(60)}\n`);
      await appendFile(logFile, `[${endTime}] PROCESS ERROR\n`);
      await appendFile(logFile, `${"!".repeat(60)}\n`);
      await appendFile(logFile, `Error: ${err.message}\n`);
      await appendFile(logFile, `Code: ${err.code || "unknown"}\n`);
      await appendFile(logFile, `Duration: ${formatDuration(elapsed)}\n`);
      await appendFile(logFile, `${"!".repeat(60)}\n`);

      logStream.end();

      // Send error notification
      await sendProgress(taskId, `Task error: ${err.message}`, {
        status: "failed",
        error: err.message,
        errorCode: err.code,
        duration: formatDuration(elapsed),
      });

      taskRecord.status = "failed";
      taskRecord.error = err.message;
      taskRecord.failureReason = failureReason;
      taskRecord.completedAt = endTime;
      taskRecord.duration = elapsed;
      taskRecord.durationFormatted = formatDuration(elapsed);
      taskRecord.pid = null;

      await writeFile(debugFile, JSON.stringify(taskRecord, null, 2));
      await saveTasks();

      resolve({
        status: "failed",
        error: err.message,
        failureReason,
        duration: elapsed,
        durationFormatted: formatDuration(elapsed),
      });
    });
  });

  if (asyncMode) {
    // Return immediately with task ID
    return {
      content: [
        {
          type: "text",
          text: `## Codex Task Started\n\n` +
            `**Task ID:** \`${taskId}\`\n` +
            `**PID:** ${codex.pid}\n` +
            `**Status:** running\n` +
            `**Log file:** ${logFile}\n` +
            `**Debug file:** ${debugFile}\n\n` +
            `Use \`codex_status\` with this task ID to check progress.\n` +
            `Use \`codex_cancel\` to stop the task.\n\n` +
            `> **Note:** Progress notifications will be sent every 30 seconds while the task runs.`,
        },
      ],
    };
  } else {
    // Wait for completion
    const result = await completionPromise;
    return {
      content: [
        {
          type: "text",
          text: formatResult(taskId, taskRecord, result),
        },
      ],
    };
  }
}

async function handleCodexStatus(args) {
  const taskId = args.taskId;
  const tailLines = args.tailLines || 50;

  const taskRecord = tasks.get(taskId);
  if (!taskRecord) {
    return {
      content: [{ type: "text", text: `Task not found: ${taskId}` }],
      isError: true,
    };
  }

  // Calculate elapsed/duration
  const startTime = new Date(taskRecord.startedAt).getTime();
  const endTime = taskRecord.completedAt ? new Date(taskRecord.completedAt).getTime() : Date.now();
  const elapsed = endTime - startTime;
  const lastActivity = taskRecord.lastActivityAt
    ? Date.now() - new Date(taskRecord.lastActivityAt).getTime()
    : null;

  // Read recent log lines
  let recentLogs = "";
  try {
    const fullLog = await readFile(taskRecord.logFile, "utf-8");
    const lines = fullLog.split("\n");
    recentLogs = lines.slice(-tailLines).join("\n");
  } catch {
    recentLogs = "(no logs yet)";
  }

  let output = `## Codex Task Status\n\n`;
  output += `**Task ID:** ${taskId}\n`;
  output += `**Status:** ${taskRecord.status}\n`;
  output += `**Task:** ${taskRecord.task.slice(0, 100)}${taskRecord.task.length > 100 ? '...' : ''}\n`;
  output += `**Started:** ${taskRecord.startedAt}\n`;

  if (taskRecord.status === "running") {
    output += `**Elapsed:** ${formatDuration(elapsed)}\n`;
    output += `**PID:** ${taskRecord.pid}\n`;
    if (lastActivity !== null) {
      output += `**Last activity:** ${formatDuration(lastActivity)} ago (${taskRecord.lastActivityType})\n`;
    }
    output += `**Heartbeats:** ${taskRecord.heartbeatCount}\n`;
    if (taskRecord.lastOutputSnippet) {
      output += `**Recent output:** \`${taskRecord.lastOutputSnippet.slice(-80)}...\`\n`;
    }
  }

  if (taskRecord.completedAt) {
    output += `**Completed:** ${taskRecord.completedAt}\n`;
    output += `**Duration:** ${taskRecord.durationFormatted || formatDuration(elapsed)}\n`;
  }

  // Diagnostics section
  output += `\n### Diagnostics\n`;
  output += `| Metric | Value |\n`;
  output += `|--------|-------|\n`;
  output += `| Exit code | ${taskRecord.exitCode ?? "(running)"} |\n`;
  output += `| Exit signal | ${taskRecord.exitSignal || "none"} |\n`;
  output += `| Stdout bytes | ${taskRecord.stdoutBytes || 0} |\n`;
  output += `| Stderr bytes | ${taskRecord.stderrBytes || 0} |\n`;
  output += `| Timeout | ${taskRecord.timeoutMs > 0 ? `${taskRecord.timeoutMs}ms` : "none"} |\n`;

  if (taskRecord.failureReason) {
    output += `\n### Failure Reason\n\`\`\`\n${taskRecord.failureReason}\n\`\`\`\n`;
  }

  output += `\n### Recent Logs (last ${tailLines} lines)\n\`\`\`\n${recentLogs}\n\`\`\`\n`;

  if (taskRecord.result) {
    output += `\n### Result\n${taskRecord.result}\n`;
  }

  // Add debug file location
  output += `\n---\n**Debug file:** ${taskRecord.debugFile}\n`;

  return {
    content: [{ type: "text", text: output }],
  };
}

async function handleCodexTasks(args) {
  const statusFilter = args.status || "all";
  const limit = args.limit || 20;

  let filtered = Array.from(tasks.values());

  if (statusFilter !== "all") {
    filtered = filtered.filter((t) => t.status === statusFilter);
  }

  // Sort by start time descending
  filtered.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  filtered = filtered.slice(0, limit);

  if (filtered.length === 0) {
    return {
      content: [{ type: "text", text: "No tasks found." }],
    };
  }

  let output = `## Codex Tasks (${statusFilter})\n\n`;
  output += `| ID | Status | Duration | Exit | Task |\n`;
  output += `|----|--------|----------|------|------|\n`;

  for (const t of filtered) {
    const shortTask = t.task.length > 30 ? t.task.slice(0, 30) + "..." : t.task;
    const duration = t.durationFormatted || (t.status === "running"
      ? formatDuration(Date.now() - new Date(t.startedAt).getTime())
      : "-");
    const exit = t.exitSignal || (t.exitCode !== null ? t.exitCode : "-");
    output += `| ${t.id} | ${t.status} | ${duration} | ${exit} | ${shortTask} |\n`;
  }

  return {
    content: [{ type: "text", text: output }],
  };
}

async function handleCodexCancel(args) {
  const taskId = args.taskId;
  const taskRecord = tasks.get(taskId);

  if (!taskRecord) {
    return {
      content: [{ type: "text", text: `Task not found: ${taskId}` }],
      isError: true,
    };
  }

  if (taskRecord.status !== "running") {
    return {
      content: [{ type: "text", text: `Task ${taskId} is not running (status: ${taskRecord.status})` }],
    };
  }

  const codex = activeProcesses.get(taskId);
  if (!codex) {
    return {
      content: [{ type: "text", text: `Task ${taskId} has no active process handle` }],
      isError: true,
    };
  }

  try {
    taskRecord.failureReason = "Cancelled by user";
    await appendFile(taskRecord.logFile, `\n[${new Date().toISOString()}] CANCELLED: User requested cancellation\n`);

    await sendProgress(taskId, "Task cancellation requested", {
      status: "cancelling",
    });

    codex.kill("SIGTERM");

    // Give it a moment then force kill if needed
    setTimeout(() => {
      if (taskRecord.status === "running") {
        try {
          codex.kill("SIGKILL");
          appendFile(taskRecord.logFile, `[${new Date().toISOString()}] SIGKILL sent after SIGTERM timeout\n`);
        } catch {
          // Already dead
        }
      }
    }, 5000);

    return {
      content: [{ type: "text", text: `Sent SIGTERM to task ${taskId} (PID ${taskRecord.pid}). Task will be cancelled.` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to cancel task: ${err.message}` }],
      isError: true,
    };
  }
}

async function handleCodexWait(args) {
  const taskId = args.taskId;
  const pollIntervalMs = args.pollIntervalMs || 5000;
  const timeoutMs = args.timeoutMs || 0;

  const taskRecord = tasks.get(taskId);
  if (!taskRecord) {
    return {
      content: [{ type: "text", text: `Task not found: ${taskId}` }],
      isError: true,
    };
  }

  // If already completed, return immediately
  if (taskRecord.status !== "running") {
    return {
      content: [
        {
          type: "text",
          text: formatWaitResult(taskId, taskRecord),
        },
      ],
    };
  }

  const startWait = Date.now();

  // Poll until complete or timeout
  return new Promise((resolve) => {
    const checkStatus = async () => {
      const record = tasks.get(taskId);

      // Check if completed
      if (record.status !== "running") {
        resolve({
          content: [
            {
              type: "text",
              text: formatWaitResult(taskId, record),
            },
          ],
        });
        return;
      }

      // Check timeout
      if (timeoutMs > 0 && Date.now() - startWait > timeoutMs) {
        resolve({
          content: [
            {
              type: "text",
              text: `## Codex Wait Timeout\n\n` +
                `**Task ID:** ${taskId}\n` +
                `**Status:** still running\n` +
                `**Waited:** ${formatDuration(Date.now() - startWait)}\n` +
                `**Timeout:** ${formatDuration(timeoutMs)}\n\n` +
                `Task is still running. Use \`codex_status\` to check progress or \`codex_cancel\` to stop it.`,
            },
          ],
        });
        return;
      }

      // Send progress notification while waiting
      await sendProgress(taskId, `Waiting for task (${formatDuration(Date.now() - startWait)} elapsed)`, {
        status: "waiting",
        taskStatus: record.status,
        waitElapsed: formatDuration(Date.now() - startWait),
      });

      // Continue polling
      setTimeout(checkStatus, pollIntervalMs);
    };

    checkStatus();
  });
}

function formatWaitResult(taskId, taskRecord) {
  const status = taskRecord.status === "completed" ? "completed successfully" : taskRecord.status;
  let output = `## Codex Task Completed\n\n`;
  output += `**Task ID:** ${taskId}\n`;
  output += `**Status:** ${status}\n`;
  output += `**Duration:** ${taskRecord.durationFormatted || "unknown"}\n`;

  if (taskRecord.exitCode !== undefined && taskRecord.exitCode !== null) {
    output += `**Exit code:** ${taskRecord.exitCode}\n`;
  }

  if (taskRecord.exitSignal) {
    output += `**Exit signal:** ${taskRecord.exitSignal}\n`;
  }

  if (taskRecord.failureReason) {
    output += `**Failure reason:** ${taskRecord.failureReason}\n`;
  }

  // Summary stats
  output += `\n### Summary\n`;
  output += `- Stdout: ${taskRecord.stdoutBytes || 0} bytes\n`;
  output += `- Stderr: ${taskRecord.stderrBytes || 0} bytes\n`;
  output += `- Heartbeats: ${taskRecord.heartbeatCount || 0}\n`;

  if (taskRecord.result) {
    output += `\n### Result\n${taskRecord.result}\n`;
  }

  return output;
}

function formatResult(taskId, taskRecord, result) {
  const status = result.status === "completed" ? "completed successfully" : result.status;
  let output = `## Codex Agent Result\n\n`;
  output += `**Task ID:** ${taskId}\n`;
  output += `**Status:** ${status}\n`;
  output += `**Duration:** ${result.durationFormatted}\n`;

  if (result.exitCode !== undefined && result.exitCode !== null) {
    output += `**Exit code:** ${result.exitCode}\n`;
  }

  if (result.exitSignal) {
    output += `**Exit signal:** ${result.exitSignal}\n`;
  }

  if (result.failureReason) {
    output += `**Failure reason:** ${result.failureReason}\n`;
  }

  if (result.error) {
    output += `**Error:** ${result.error}\n`;
  }

  // Diagnostics summary
  output += `\n### Diagnostics\n`;
  output += `- Stdout: ${taskRecord.stdoutBytes} bytes\n`;
  output += `- Stderr: ${taskRecord.stderrBytes} bytes\n`;
  output += `- Heartbeats: ${taskRecord.heartbeatCount}\n`;
  output += `- Log file: ${taskRecord.logFile}\n`;
  output += `- Debug file: ${taskRecord.debugFile}\n`;

  if (result.result) {
    output += `\n### Output\n${result.result}\n`;
  }

  return output;
}

// Start server
async function main() {
  await initDirs();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Codex Connector MCP server v1.2.0 running on stdio");
  console.error(`Logs directory: ${LOGS_DIR}`);
  console.error(`Codex path: ${CODEX_PATH}`);
  console.error("Progress notifications enabled");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
