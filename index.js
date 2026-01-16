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
        task.status = "unknown (server restarted)";
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

const server = new Server(
  {
    name: "codex-connector",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

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
              description: "Optional model override",
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
          "Check the status of a Codex task. Returns status, logs, and result if completed.",
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
              enum: ["all", "running", "completed", "failed"],
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
  const model = args.model;
  const asyncMode = args.async || false;
  const timeoutMs = args.timeoutMs || 0;

  const logFile = join(LOGS_DIR, `${taskId}.log`);
  const resultFile = join(LOGS_DIR, `${taskId}.result`);

  // Create task record
  const taskRecord = {
    id: taskId,
    task,
    sandbox,
    workingDirectory,
    model,
    status: "running",
    startedAt: new Date().toISOString(),
    logFile,
    resultFile,
    pid: null,
  };
  tasks.set(taskId, taskRecord);
  await saveTasks();

  // Start the codex process
  const codexArgs = [
    "exec",
    "--full-auto",
    "--sandbox",
    sandbox,
    "--output-last-message",
    resultFile,
    task,
  ];

  if (model) {
    codexArgs.splice(1, 0, "--model", model);
  }

  const logStream = createWriteStream(logFile, { flags: "a" });
  await appendFile(logFile, `[${new Date().toISOString()}] Starting Codex task: ${task}\n`);
  await appendFile(logFile, `[${new Date().toISOString()}] Working directory: ${workingDirectory}\n`);
  await appendFile(logFile, `[${new Date().toISOString()}] Sandbox: ${sandbox}\n\n`);

  const codex = spawn(CODEX_PATH, codexArgs, {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  taskRecord.pid = codex.pid;
  await saveTasks();

  // Stream output to log file
  codex.stdout.on("data", (data) => {
    logStream.write(data);
  });

  codex.stderr.on("data", (data) => {
    logStream.write(`[stderr] ${data}`);
  });

  // Set up timeout if specified
  let timeout = null;
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      appendFile(logFile, `\n[${new Date().toISOString()}] TIMEOUT: Killing process after ${timeoutMs}ms\n`);
      codex.kill("SIGTERM");
      setTimeout(() => codex.kill("SIGKILL"), 5000);
    }, timeoutMs);
  }

  // Handle completion
  const completionPromise = new Promise((resolve) => {
    codex.on("close", async (code) => {
      if (timeout) clearTimeout(timeout);

      const endTime = new Date().toISOString();
      await appendFile(logFile, `\n[${endTime}] Process exited with code ${code}\n`);
      logStream.end();

      // Read result file
      let result = null;
      try {
        result = await readFile(resultFile, "utf-8");
      } catch {
        // No result file
      }

      taskRecord.status = code === 0 ? "completed" : "failed";
      taskRecord.exitCode = code;
      taskRecord.completedAt = endTime;
      taskRecord.result = result;
      taskRecord.pid = null;
      await saveTasks();

      resolve({
        status: taskRecord.status,
        exitCode: code,
        result,
      });
    });

    codex.on("error", async (err) => {
      if (timeout) clearTimeout(timeout);

      await appendFile(logFile, `\n[${new Date().toISOString()}] Process error: ${err.message}\n`);
      logStream.end();

      taskRecord.status = "failed";
      taskRecord.error = err.message;
      taskRecord.pid = null;
      await saveTasks();

      resolve({
        status: "failed",
        error: err.message,
      });
    });
  });

  if (asyncMode) {
    // Return immediately with task ID
    return {
      content: [
        {
          type: "text",
          text: `## Codex Task Started\n\n**Task ID:** \`${taskId}\`\n**Status:** running\n**Log file:** ${logFile}\n\nUse \`codex_status\` with this task ID to check progress.\nUse \`codex_cancel\` to stop the task.`,
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
          text: formatResult(taskId, result),
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
  output += `**Task:** ${taskRecord.task}\n`;
  output += `**Started:** ${taskRecord.startedAt}\n`;

  if (taskRecord.completedAt) {
    output += `**Completed:** ${taskRecord.completedAt}\n`;
  }

  if (taskRecord.exitCode !== undefined) {
    output += `**Exit code:** ${taskRecord.exitCode}\n`;
  }

  if (taskRecord.pid) {
    output += `**PID:** ${taskRecord.pid}\n`;
  }

  output += `\n### Recent Logs (last ${tailLines} lines)\n\`\`\`\n${recentLogs}\n\`\`\`\n`;

  if (taskRecord.result) {
    output += `\n### Result\n${taskRecord.result}\n`;
  }

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
  output += `| ID | Status | Task | Started |\n`;
  output += `|----|--------|------|--------|\n`;

  for (const t of filtered) {
    const shortTask = t.task.length > 40 ? t.task.slice(0, 40) + "..." : t.task;
    output += `| ${t.id} | ${t.status} | ${shortTask} | ${t.startedAt} |\n`;
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

  if (taskRecord.status !== "running" || !taskRecord.pid) {
    return {
      content: [{ type: "text", text: `Task ${taskId} is not running (status: ${taskRecord.status})` }],
    };
  }

  try {
    process.kill(taskRecord.pid, "SIGTERM");
    await appendFile(taskRecord.logFile, `\n[${new Date().toISOString()}] Task cancelled by user\n`);

    // Give it a moment then force kill if needed
    setTimeout(() => {
      try {
        process.kill(taskRecord.pid, "SIGKILL");
      } catch {
        // Already dead
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

function formatResult(taskId, result) {
  const status = result.status === "completed" ? "completed successfully" : result.status;
  let output = `## Codex Agent Result\n\n`;
  output += `**Task ID:** ${taskId}\n`;
  output += `**Status:** ${status}\n`;

  if (result.exitCode !== undefined) {
    output += `**Exit code:** ${result.exitCode}\n`;
  }

  if (result.error) {
    output += `**Error:** ${result.error}\n`;
  }

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
  console.error("Codex Connector MCP server running on stdio");
  console.error(`Logs directory: ${LOGS_DIR}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
