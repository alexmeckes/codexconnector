# Codex Connector

An MCP (Model Context Protocol) server that connects Claude Code to OpenAI's Codex CLI, enabling Claude to delegate coding tasks to Codex agents.

## Features

- **Spawn Codex agents** from within Claude Code sessions
- **Async task management** - run long tasks in the background
- **Real-time log streaming** - monitor task progress
- **Enhanced debugging** - heartbeats, activity tracking, failure diagnostics
- **Progress notifications** - keeps Claude informed during long-running tasks
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
| `sessionId` | string | No | Resume a previous Codex session (enables conversation continuity) |

**Example:**
```
Use codex_agent to refactor the authentication module in /path/to/project
```

### `codex_status`

Check the status of a running or completed task. Returns enhanced diagnostics including:
- Exit code and signal
- Stdout/stderr byte counts
- Last activity timestamp
- Failure reason (if applicable)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | The task ID from codex_agent |
| `tailLines` | number | No | Number of recent log lines (default: 50) |

### `codex_tasks`

List all Codex tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter: `all`, `running`, `completed`, `failed`, or `interrupted` |
| `limit` | number | No | Max tasks to return (default: 20) |

### `codex_cancel`

Cancel a running task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | The task ID to cancel |

### `codex_wait`

Wait for a Codex task to complete. Blocks until the task finishes, then returns the full result. This is the recommended way for subagents to monitor async tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | Yes | The task ID to wait for |
| `pollIntervalMs` | number | No | How often to check status (default: 5000ms) |
| `timeoutMs` | number | No | Max time to wait, 0 = no timeout (default: 0) |

## Subagent Monitoring Pattern (v1.4.0)

When you spawn an async Codex task, Claude will automatically be instructed to create a background subagent that monitors the task using `codex_wait`. This ensures:

1. **Reliable completion notification** - The subagent blocks until the task finishes
2. **Non-blocking main conversation** - Claude can continue working on other things
3. **Automatic result reporting** - When the task completes, the subagent reports back

### How It Works

1. You ask Claude to run a Codex task
2. Claude spawns the task with `async: true`
3. The response instructs Claude to spawn a monitoring subagent
4. The subagent calls `codex_wait(taskId)` which blocks until completion
5. When the task finishes, the subagent reports the results

### Manual Usage

If you need to manually wait for a task:

```
Use codex_wait with taskId "abc123" to wait for the task to complete
```

## Session Continuation (v1.5.0)

Codex tasks now support conversation continuity. When a task completes, you receive a **Session ID** that can be used to resume the conversation in a follow-up task.

### How It Works

1. Run a Codex task - on completion, you'll see a `Session ID` in the result
2. To continue the conversation, pass that `sessionId` to your next `codex_agent` call
3. Codex will resume with full context of the previous conversation

### Example

**First task:**
```
Use codex_agent to analyze the database schema in /path/to/project
```

Result includes: `Session ID: 019bd162-b15d-7a80-9679-31c377b79825`

**Follow-up task (continues the conversation):**
```
Use codex_agent with sessionId "019bd162-b15d-7a80-9679-31c377b79825"
to now add indexes based on your analysis
```

### Benefits

- **Context preservation** - Codex remembers what it analyzed, what files it read, what decisions it made
- **Iterative workflows** - Build on previous work without re-explaining
- **Debugging continuity** - Ask follow-up questions about errors or outputs

### Notes

- Session IDs are also shown in `codex_status` output
- Sessions are stored locally by Codex CLI in `~/.codex/sessions/`
- When resuming, sandbox mode is inherited from the original session

## Progress Notifications (v1.2.0)

The server sends MCP logging notifications to keep Claude informed during long-running tasks. This prevents Claude from thinking a task is stuck and prematurely cancelling it.

### Notifications Sent

| Event | When | Data Included |
|-------|------|---------------|
| Task started | Immediately on spawn | Task ID, task description |
| Heartbeat | Every 30 seconds | Elapsed time, bytes received, last activity, recent output snippet |
| Stall warning | No activity for 2+ minutes | Elapsed time, time since last activity |
| Timeout | When timeout limit reached | Elapsed time, timeout limit |
| Completion | Task finishes | Status, duration, exit code/signal |
| Error | Process error occurs | Error message, error code |

### Example Notification Data

```json
{
  "level": "info",
  "logger": "codex-connector",
  "data": {
    "taskId": "a1b2c3d4",
    "message": "Task still running (2m 30s elapsed)",
    "status": "running",
    "elapsed": "2m 30s",
    "heartbeat": 5,
    "stdoutBytes": 15234,
    "stderrBytes": 892,
    "lastActivity": "5.2s ago",
    "lastActivityType": "stderr",
    "recentOutput": "exec /bin/zsh -lc 'cat file.txt' succeeded..."
  }
}
```

This helps Claude understand that:
- The task is still running (not frozen)
- Progress is being made (bytes increasing)
- What Codex is currently doing (recent output)

## Debugging Features (v1.1.0)

### Enhanced Logging

Each task generates three files in `~/.codex-connector/logs/`:

1. **`<task-id>.log`** - Full output log with:
   - Task header (command, working directory, sandbox, model, timeout)
   - Timestamped stdout/stderr from Codex
   - Heartbeat messages every 30 seconds
   - Activity warnings (no output for 2+ minutes)
   - Detailed exit summary

2. **`<task-id>.result`** - Codex's final output message

3. **`<task-id>.debug.json`** - Structured debug data:
   - Full command that was executed
   - Environment info
   - Byte counts (stdout/stderr)
   - Timestamps and duration
   - Exit code/signal
   - Failure reason

### Diagnostics Table

The `codex_status` tool now includes a diagnostics table:

```
### Diagnostics
| Metric | Value |
|--------|-------|
| Exit code | 1 |
| Exit signal | SIGTERM |
| Stdout bytes | 15234 |
| Stderr bytes | 892 |
| Timeout | 300000ms |
```

### Failure Tracking

Tasks now track detailed failure reasons:

- **Signal kills**: `Killed by SIGTERM`, `Killed by SIGKILL`
- **Timeouts**: `Timeout after 5m 0s (limit: 5m 0s)`
- **Exit codes**: `Exited with code 1`
- **Process errors**: `Process error: ENOENT (spawn failed)`
- **User cancellation**: `Cancelled by user`
- **Server restart**: `Server restarted while task was running`

### Heartbeat Monitoring

For long-running tasks, heartbeats are logged every 30 seconds:

```
[2024-01-15T10:30:00.000Z] HEARTBEAT #5: elapsed=2m 30s, lastActivity=15.2s ago (stderr), stdout=12450B, stderr=890B
```

If no activity for 2+ minutes, a warning is logged:
```
[2024-01-15T10:32:00.000Z] WARNING: No activity for 2m 15s
```

## How It Works

1. Claude Code calls `codex_agent` with a task
2. The MCP server spawns the Codex CLI in `--full-auto` mode
3. Codex executes the task autonomously
4. Logs are streamed to `~/.codex-connector/logs/`
5. Heartbeats track progress for long-running tasks
6. Results are returned to Claude Code with full diagnostics

## Data Storage

- **Logs**: `~/.codex-connector/logs/<task-id>.log`
- **Results**: `~/.codex-connector/logs/<task-id>.result`
- **Debug info**: `~/.codex-connector/logs/<task-id>.debug.json`
- **Task state**: `~/.codex-connector/tasks.json`

## Requirements

- The working directory must be a git repository (Codex requirement)
- OpenAI API key must be configured for Codex CLI

## Troubleshooting

### Task shows "interrupted" status
The MCP server was restarted while the task was running. Check the log file for the last known state.

### Task failed with no output
Check the debug.json file for the exact command and environment. Common causes:
- Codex CLI not installed or not in PATH
- Working directory is not a git repo
- OpenAI API key not set

### Task seems stuck
Use `codex_status` to check:
- Last activity timestamp
- Heartbeat count
- Stdout/stderr byte counts

If no activity for several minutes, consider cancelling with `codex_cancel`.

## License

MIT
