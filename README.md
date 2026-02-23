# Orca

Multi-agent CLI orchestrator for AI coding tools. Coordinates Claude Code, Codex, Aider, and other CLI agents on shared codebases using git worktree isolation and a scrum-inspired execution model.

## How It Works

Orca wraps existing AI CLI tools as workers — it doesn't call LLM APIs directly. The execution model mirrors a dev team:

1. **Explore** — Analyze the codebase and generate context
2. **Plan** — Decompose goals into small, dependency-aware tasks
3. **Sprint** — Execute tasks in parallel on isolated git worktrees
4. **Review** — Review diffs with quality gates (scope check, test delta, alignment)
5. **Integrate** — Merge approved work into an integration branch with validation

Workers never communicate directly. All coordination flows through the supervisor (you, or an LLM in autopilot mode).

## Features

- **Tool-agnostic** — Works with any CLI agent (Claude Code, Codex, Aider, or custom tools)
- **Git worktree isolation** — Each task runs on its own branch (`orca/task-{id}`), no file collisions
- **Smart integration** — Merges smallest diffs first to minimize conflicts, with rebase and tool-assisted conflict resolution
- **Quality gates** — Scope creep detection, test regression analysis, optional LLM alignment checks
- **Sprint monitoring** — Stuck detection, budget enforcement, live conflict prediction
- **Crash recovery** — Detects orphaned tasks and interrupted sprints, recovers gracefully
- **Cost tracking** — Per-task and per-sprint cost tracking with budget caps
- **Web UI** — Real-time board view with WebSocket updates, console panel, terminal streaming
- **MCP server** — 30 MCP tools for LLM-driven orchestration (autopilot mode)
- **Single binary** — Go binary with embedded web frontend, SQLite state, YAML config

## Requirements

- Go 1.25+
- Git
- At least one supported AI CLI tool: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), or [Aider](https://aider.chat)
- [Task](https://taskfile.dev) (optional, for build commands)
- [Bun](https://bun.sh) (for building the web frontend)

## Installation

```bash
git clone https://github.com/jasjeetmavi/orca.git
cd orca
task build
```

The binary is output to `dist/orca`. Add `dist/` to your `PATH` or copy it where you need it.

## Quick Start

```bash
# Initialize in a git repo
cd your-project
orca init

# Explore the codebase (generates context for workers)
orca explore

# Add tasks to the backlog
orca backlog add "Implement user authentication"
orca backlog add "Add rate limiting to API endpoints"

# Or break down a goal into tasks automatically
orca breakdown "Add comprehensive error handling across the API layer"

# Plan and run a sprint
orca sprint plan
orca sprint start

# Review completed work
orca sprint review
orca sprint review --auto    # LLM-assisted review

# Integrate approved tasks
orca integrate

# Launch web UI
orca serve
```

## CLI Reference

```
orca init                          Initialize Orca in a git repo
orca explore                       Analyze codebase, generate context
orca explore --check               Check if context is stale
orca explore --manual <file>       Use a markdown file as context

orca breakdown "goal"              Break down a goal into tasks
orca backlog                       List all tasks
orca backlog add "title"           Add a task
orca backlog show <id>             Show full task details
orca backlog edit <id>             Edit a task
orca backlog delete <id>           Delete a task
orca backlog reopen <id...>        Move failed tasks back to pending
orca backlog merge <id>            Merge a completed task
orca backlog plan <id>             Generate implementation plan for a task

orca sprint plan                   Select tasks for next sprint
orca sprint assign <id...>         Manually add tasks to sprint
orca sprint unassign <id...>       Remove tasks from sprint
orca sprint start                  Execute the sprint
orca sprint status                 Check worker progress
orca sprint review                 Review completed work
orca sprint resume                 Recover interrupted sprint
orca sprint cancel                 Cancel running sprint
orca sprint reset                  Reset sprint, revert tasks

orca review approve <id>           Approve a reviewed task
orca review request-changes <id>   Request changes on a task

orca integrate                     Merge approved tasks
orca integrate --dry-run           Preview integration

orca run                           Plan, start, review, integrate in one shot
orca cleanup                       Remove stale worktrees
orca status                        Show project overview
orca log                           Show sprint history
orca costs                         Show cost summary
orca ops                           List tracked operations
orca config show                   Print current config
orca models                        List available models
orca serve                         Start web UI
orca mcp                           Run MCP server (stdio)
orca orc                           Launch orchestrator agent
```

## Configuration

Orca stores config in `.orca/orca.yaml`. Run `orca init` to generate a fully annotated config.

```yaml
project:
  name: my-project
  integration_branch: orca/integration
  worktree_dir: .orca/worktrees

tools:
  claude:
    binary: claude
    model: claude-sonnet-4-6
    headless_args: ["-p", "{{prompt}}", "--output-format", "json"]
    timeout: 600s
  codex:
    binary: codex
    headless_args: ["exec", "{{prompt}}", "--full-auto"]
    timeout: 600s

defaults:
  tool: claude
  model: ""

workers:
  max_parallel: 3

orchestrator:
  cost_budget: 5.0
  supervisor_tool: claude
  supervisor_model: ""
  phases: {}

validation:
  commands:
    - "go test ./..."

monitor:
  stuck_check_interval: 30s
  max_stuck_cycles: 3
  conflict_check_interval: 15s
  task_budget: 0

quality:
  enabled: true
  scope_check: true
  test_delta: true
  alignment_check: false

cleanup:
  ttl: 168h

server:
  addr: ":8080"
```

## MCP Configuration

Orca ships an MCP server (`orca mcp`) that exposes 30+ tools for orchestration. When you run `orca serve` or `orca orc`, MCP configs are auto-generated for supported tools:

| Tool | Config file | How it's used |
|------|-------------|---------------|
| Claude | `.orca/mcp.json` | Passed via `--mcp-config` flag (configured in `interactive_args`) |
| Codex | `.codex/config.toml` | Auto-discovered by codex from project directory |

### Other tools (manual setup)

For tools not listed above (e.g. aider, custom CLIs), you must configure MCP manually. Orca's MCP server runs over stdio:

```bash
# The MCP server command:
orca mcp
```

Point your tool's MCP config at this command. For example, if your tool reads a JSON MCP config:

```json
{
  "mcpServers": {
    "orca": {
      "command": "/path/to/orca",
      "args": ["mcp"],
      "cwd": "/path/to/your/repo"
    }
  }
}
```

Or for TOML-based configs:

```toml
[mcp_servers.orca]
command = "/path/to/orca"
args = ["mcp"]
cwd = "/path/to/your/repo"
```

The `ORCA_MCP_CONFIG` environment variable is also set at runtime pointing to `.orca/mcp.json` — tools that support env-based config can use this.

## Project Structure

```
cmd/orca/           CLI entry point and all commands
internal/
  api/              HTTP/WebSocket API server
  banner/           ASCII banner for init
  config/           YAML config loading + defaults
  cost/             Cost tracking and parsing
  decompose/        Goal -> task decomposition via LLM
  explore/          Codebase exploration + staleness
  integrator/       Merge ordering, conflict resolution
  llm/              Low-level LLM invocation helpers
  mcp/              MCP tool definitions (stdio server)
  model/            Model catalog per tool
  monitor/          Stuck detection, budget, conflicts
  ops/              Operation tracking store
  orchestrator/     Supervisor agent launcher + MCP config
  plan/             Task implementation plan generation
  pty/              PTY session management for web terminal
  quality/          Scope check, test delta
  review/           Automated review
  sprint/           Sprint planning + execution
  state/            SQLite state DB + change watcher
  task/             Task store (SQLite)
  testutil/         Shared test helpers
  worker/           Worker execution (headless + interactive)
  worktree/         Git worktree management
prompts/            LLM prompt templates
web/                React + Vite frontend
```

## License

[MIT](LICENSE)
