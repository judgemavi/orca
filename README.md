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
- **MCP server** — 19 MCP tools for LLM-driven orchestration (autopilot mode)
- **Single binary** — Go binary with embedded web frontend, SQLite state, YAML config

## Requirements

- Go 1.25+
- Git
- At least one supported AI CLI tool: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), or [Aider](https://aider.chat)
- [Task](https://taskfile.dev) (optional, for build commands)
- [Bun](https://bun.sh) (for building the web frontend)

## Installation

```bash
git clone https://github.com/jasjeetmavi/openorc.git
cd openorc
task build
```

Binaries are output to `dist/`:
- `dist/orca` — Main CLI
- `dist/orca-mcp` — MCP server binary

Add `dist/` to your `PATH` or copy the binaries where you need them.

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

# Or decompose a goal into tasks automatically
orca plan "Add comprehensive error handling across the API layer"

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

orca plan "goal"                   Decompose a goal into tasks
orca backlog                       List all tasks
orca backlog add "title"           Add a task
orca backlog edit <id>             Edit a task

orca sprint plan                   Select tasks for next sprint
orca sprint assign <id>            Manually add task to sprint
orca sprint start                  Execute the sprint
orca sprint status                 Check worker progress
orca sprint review                 Review completed work
orca sprint resume                 Recover interrupted sprint
orca sprint cancel                 Cancel running sprint
orca sprint reset                  Reset sprint, revert tasks

orca integrate                     Merge approved tasks
orca integrate --dry-run           Preview integration

orca cleanup                       Remove stale worktrees
orca status                        Show project overview
orca log                           Show sprint history
orca costs                         Show cost summary
orca config show                   Print current config
orca config set <key> <value>      Update a config value
orca models                        List available models
orca serve                         Start web UI
orca orc                           Launch orchestrator agent
```

## Configuration

Orca stores config in `.orca/orca.yaml`. See [`orca.sample.yaml`](orca.sample.yaml) for a full annotated example.

```yaml
project:
  integration_branch: orca/integration
  worktree_dir: .orca/worktrees

tools:
  claude:
    binary: claude
    headless_args: ["-p", "{{prompt}}", "--output-format", "json"]
    timeout: 600s
  codex:
    binary: codex
    headless_args: ["exec", "{{prompt}}", "--full-auto"]
    timeout: 600s

workers:
  max_parallel: 3

orchestrator:
  cost_budget: 5.0
  supervisor_tool: claude

validation:
  commands:
    - "go test ./..."

monitor:
  stuck_check_interval: 30s
  max_stuck_cycles: 3
  task_budget: 0

quality:
  scope_check: true
  test_delta: true
  alignment_check: false
```

## Project Structure

```
cmd/orca/           CLI entry point and commands
cmd/mcp/            MCP server entry point
internal/
  api/              HTTP/WebSocket API server
  config/           YAML config loading + defaults
  cost/             Cost tracking and parsing
  explore/          Codebase exploration + staleness
  integrator/       Merge ordering, conflict resolution
  mcp/              MCP tool definitions
  monitor/          Stuck detection, budget, conflicts
  plan/             Goal decomposition
  quality/          Scope check, test delta
  review/           Automated review
  sprint/           Sprint planning + execution
  task/             Task store (SQLite)
  worker/           Worker execution (headless + interactive)
  worktree/         Git worktree management
prompts/            LLM prompt templates
web/                React + Vite frontend
```

## License

[MIT](LICENSE)
