#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SERVER_ENTRY = resolve(REPO_ROOT, "index.js");
const EXPECTED_TOOLS = new Set([
  "codex_agent",
  "codex_status",
  "codex_tasks",
  "codex_cancel",
  "codex_wait",
  "codex_list_sessions",
]);

function makeTempHome(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function getText(result) {
  return result?.content?.[0]?.text || "";
}

async function withClient({ name, env }, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: REPO_ROOT,
    env,
  });
  const client = new Client({ name: `regression-${name}`, version: "1.0.0" });
  await client.connect(transport);

  try {
    await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      // Ignore close errors to preserve original test failure.
    }
  }
}

async function testListTools() {
  const home = makeTempHome("codexconnector-regression-tools");
  await withClient(
    {
      name: "list-tools",
      env: { ...process.env, HOME: home },
    },
    async (client) => {
      const listed = await client.listTools();
      const names = new Set((listed.tools || []).map((t) => t.name));
      for (const tool of EXPECTED_TOOLS) {
        assert(names.has(tool), `Missing tool: ${tool}`);
      }
      console.log("PASS list_tools");
    }
  );
}

async function testSessionsNoDirectory() {
  const home = makeTempHome("codexconnector-regression-sessions");
  await withClient(
    {
      name: "sessions-no-dir",
      env: { ...process.env, HOME: home },
    },
    async (client) => {
      const result = await client.callTool({
        name: "codex_list_sessions",
        arguments: { limit: 3 },
      });
      const text = getText(result);
      assert.equal(result.isError, undefined, "Expected non-error response for empty sessions");
      assert(
        text.includes("Found 0 recent session(s)."),
        "Expected empty session list output for missing ~/.codex/sessions"
      );
      console.log("PASS sessions_no_directory");
    }
  );
}

async function testInvalidWorkingDirectory() {
  const home = makeTempHome("codexconnector-regression-invalid-wd");
  await withClient(
    {
      name: "invalid-working-directory",
      env: { ...process.env, HOME: home },
    },
    async (client) => {
      const result = await client.callTool({
        name: "codex_agent",
        arguments: {
          task: "hello",
          workingDirectory: "/definitely/does/not/exist",
          async: true,
        },
      });
      const text = getText(result);
      assert.equal(result.isError, true, "Expected codex_agent to return an error for invalid workingDirectory");
      assert(
        text.includes("Working directory does not exist"),
        "Expected invalid workingDirectory message"
      );

      const running = await client.callTool({
        name: "codex_tasks",
        arguments: { status: "running", limit: 20 },
      });
      assert(
        getText(running).includes("No tasks found."),
        "Invalid workingDirectory should not leave running tasks behind"
      );
      console.log("PASS invalid_working_directory");
    }
  );
}

async function testSpawnFailureNoCrash() {
  const home = makeTempHome("codexconnector-regression-spawn");
  await withClient(
    {
      name: "spawn-failure",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
    },
    async (client) => {
      const result = await client.callTool({
        name: "codex_agent",
        arguments: {
          task: "Reply with exactly: ok",
          workingDirectory: REPO_ROOT,
          async: false,
          timeoutMs: 1500,
        },
      });
      const text = getText(result);
      assert.equal(result.isError, undefined, "Spawn failure should be reported as task failure, not MCP error");
      assert(
        text.includes("**Status:** failed"),
        "Expected failed task status when codex binary is unavailable"
      );
      assert(
        text.includes("Failure reason"),
        "Expected failure diagnostics when codex process fails to start"
      );

      const running = await client.callTool({
        name: "codex_tasks",
        arguments: { status: "running", limit: 20 },
      });
      assert(
        getText(running).includes("No tasks found."),
        "Spawn failure should not leave tasks in running state"
      );
      console.log("PASS spawn_failure_no_crash");
    }
  );
}

async function testOptionalIntegration() {
  if (process.env.RUN_CODEX_INTEGRATION !== "1") {
    console.log("SKIP codex_integration (set RUN_CODEX_INTEGRATION=1 to enable)");
    return;
  }

  const home = makeTempHome("codexconnector-regression-integration");
  await withClient(
    {
      name: "codex-integration",
      env: { ...process.env, HOME: home },
    },
    async (client) => {
      const start = await client.callTool({
        name: "codex_agent",
        arguments: {
          task: "Reply with exactly: ok",
          workingDirectory: REPO_ROOT,
          async: true,
          timeoutMs: 20000,
        },
      });

      const startText = getText(start);
      const taskMatch = startText.match(/Task ID:\*\* `([^`]+)`/);
      assert(taskMatch, "Expected Task ID in async codex_agent response");
      const taskId = taskMatch[1];

      const waited = await client.callTool({
        name: "codex_wait",
        arguments: {
          taskId,
          pollIntervalMs: 1000,
          timeoutMs: 120000,
        },
      });
      const waitedText = getText(waited);
      assert(
        waitedText.includes("## Codex Task Completed"),
        "Expected codex_wait completion output"
      );
      assert(
        waitedText.includes("completed successfully"),
        "Expected successful live Codex integration run"
      );
      console.log("PASS codex_integration");
    }
  );
}

async function main() {
  console.log("Running codex-connector regression checks...");
  await testListTools();
  await testSessionsNoDirectory();
  await testInvalidWorkingDirectory();
  await testSpawnFailureNoCrash();
  await testOptionalIntegration();
  console.log("All regression checks passed.");
}

main().catch((err) => {
  console.error("Regression checks failed.");
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
