# Codex Connector

An MCP (Model Context Protocol) server that connects Claude Code to OpenAI's Codex CLI, enabling Claude to delegate coding tasks to Codex agents.

## Features

- **Spawn Codex agents** from within Claude Code sessions
- **Async task management** - run long tasks in the background
- **Real-time log streaming** - monitor task progress
- **Task persistence** - tasks survive server restarts
- **Configurable sandbox levels** - control Codex permissions

## Installation

### Prerequisites

- Node.js 18+
- [OpenAI Codex CLI](https://github.com/openai/codex) installed and configured

### Install globally

```bash
npm install -g codex-connector
```

### Configure Claude Code

Add to your `~/.mcp.json`:

```json
{
  "mcpServers": {
    "codex-connector": {
      "command": "codex-connector"
    }
  }
}
```

Restart Claude Code and approve the MCP server when prompted.

## Usage

Once configured, you'll have access to these tools in Claude Code:

### `codex_agent`

Spawn a Codex agent to handle a coding task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | The task or prompt to send to Codex |
| `workingDirectory` | string | Yes | Working directory (must be a git repo) |
| `sandbox` | string | No | Permission level: `read-only`, `workspace-write`, or `danger-full-access` (default) |
| `model` | string | No | Model override |
| `async` | boolean | No | If true, returns immediately with task ID |
| `timeoutMs` | number | No | Timeout in milliseconds (0 = no timeout) |

**Example:**
```
Use codex_agent to refactor the authentication module in /path/to/project
```

### `codex_status`

Check the status of a running or completed task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | The task ID from codex_agent |
| `tailLines` | number | No | Number of recent log lines (default: 50) |

### `codex_tasks`

List all Codex tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter: `all`, `running`, `completed`, or `failed` |
| `limit` | number | No | Max tasks to return (default: 20) |

### `codex_cancel`

Cancel a running task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | The task ID to cancel |

## How It Works

1. Claude Code calls `codex_agent` with a task
2. The MCP server spawns the Codex CLI in `--full-auto` mode
3. Codex executes the task autonomously
4. Logs are streamed to `~/.codex-connector/logs/`
5. Results are returned to Claude Code

## Data Storage

- **Logs**: `~/.codex-connector/logs/<task-id>.log`
- **Results**: `~/.codex-connector/logs/<task-id>.result`
- **Task state**: `~/.codex-connector/tasks.json`

## Requirements

- The working directory must be a git repository (Codex requirement)
- OpenAI API key must be configured for Codex CLI

## License

MIT
