# Orca

Multi-agent CLI orchestrator for AI coding tools. Orca coordinates Claude Code, Codex, Aider, and similar CLI agents on shared codebases using git worktrees and direct task execution.

## How It Works

Orca wraps existing AI CLI tools as workers (no direct LLM API coupling).

1. `explore` — generate/refresh codebase context
2. `breakdown` — break goals into dependency-aware tasks
3. `tasks plan` / `tasks evaluate` — refine task implementation plans
4. `start` — execute ready tasks directly (parallel, isolated worktrees)
5. `review` — approve, request changes, or run AI review
6. `merge` — merge approved tasks into integration branch

Task flow: `pending → planned → running → review → approved → merged`.
Breakdown branch: `pending → broken_down` (when a parent task is split into child tasks).
Stop path: `running → stopped` (via `tasks_stop`); `stopped → running` (resume via `tasks_resume`).
Failure path: `running → failed`.

Orca handles crashes gracefully: SIGINT/SIGTERM triggers orderly shutdown (cancel workers, mark in-flight interactions failed, set run-phase tasks to stopped). On next launch, automatic startup recovery detects and resets any stale state left by hard kills (SIGKILL, OOM, power loss).

## Features

- Tool-agnostic worker execution via pluggable drivers
- Git worktree isolation per task branch (`orca/task-{id}`)
- Plan review loop (`tasks approve-plan` / `tasks request-plan-changes`)
- Quality gates + review loop (`review request-changes` re-runs task, `review ai` runs automated AI review)
- Interaction-based tracking: tokens, cost, diffs, and quality per LLM invocation
- Web UI with live status/events via WebSocket
- Task table, 3-phase timeline, diff viewer, inline review, terminal console
- MCP server for agentic orchestration (35 tools)
- Single Go binary with embedded web frontend

## Requirements

- Go 1.25+
- Git
- At least one supported AI CLI tool: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), or [Aider](https://aider.chat)
- [Task](https://taskfile.dev) (optional)
- [Bun](https://bun.sh) (for web build)

## Installation

```bash
git clone https://github.com/jasjeetmavi/orca.git
cd orca
task build
```

Binary output: `dist/orca`.

## Quick Start

```bash
# Initialize in a git repo
cd your-project
orca init

# Generate context
orca explore

# Add or break down work
orca tasks add "Implement user authentication"
orca breakdown "Add rate limiting and retry safety across API clients"

# Start ready tasks directly
orca start

# Review outcomes
orca review ai <task-id>                # AI-powered code review
orca review approve <task-id>
# or
orca review request-changes <task-id> "Address failing tests and tighten error handling"

# Merge approved tasks
orca merge

# Optional dashboard
orca serve
```

## CLI Reference

```text
orca init                    [-y]
orca explore                 [--tool] [--manual] [--stdin] [--check]
orca breakdown <goal...>     [--tool] [--auto]
orca start [task-ids...]     [--no-merge]   # alias: orca run

orca tasks / task
  ├── add <title...>         [--description] [--parent] [--depends-on]
  ├── list
  ├── edit [id]              [--title] [--description] [--plan] [--status]
  ├── delete [id]            [-y]
  ├── show [id]
  ├── stop [id]
  ├── resume [id]
  ├── add-dep <id> <dep-id>
  ├── merge [id]             [--auto]
  ├── plan [id]              [--save] [--edit] [--tool] [--model]
  ├── approve-plan [id]
  ├── request-plan-changes [id] [feedback]  [--tool] [--model]
  ├── evaluate [id]          [--tool] [--model] [--json]
  ├── reviews [id]
  └── logs <id>              [--phase] [--attempt] [--raw] [-f] [--json]

orca review
  ├── approve [id]
  ├── request-changes [id] [feedback]  [--tool] [--model]
  └── ai [id]               [--tool] [--model] [--prompt]

orca merge                   [--dry-run]
orca serve                   [-p/--port] [--orchestrator]
orca mcp
orca orc
orca status
orca logs                    [--level] [--task] [--since] [--tail] [-f] [--json]
orca models [tool]
orca config show | set <key> <value>
orca costs                   [--run]
orca ops                     [--all]
orca cleanup                 [--dry-run]
```

## MCP

`orca mcp` exposes 35 MCP tools for task orchestration:

- **Task lifecycle:** `tasks_list`, `tasks_get`, `tasks_create`, `tasks_update`, `tasks_delete`, `tasks_add_dependency`
- **Planning:** `breakdown`, `tasks_plan_generate`, `tasks_plan_evaluate`, `tasks_approve_plan`, `tasks_request_plan_changes`
- **Execution:** `tasks_start` (`tasks_run` alias), `tasks_stop` (`tasks_cancel` alias), `tasks_resume`
- **Review/integration:** `tasks_approve`, `tasks_request_changes`, `ai_review`, `tasks_reviews`, `merge`, `tasks_merge`
- **Interactions:** `interactions_list`, `interaction_get`
- **Project/config:** `project_status`, `config_get`, `config_update`, `models_list`
- **Context:** `explore`, `explore_status`
- **Worktree:** `worktree_cleanup`, `worktree_status`
- **Monitoring:** `cost_status`, `quality_results`, `log_event`, `log_query`

## Project Structure

```text
cmd/orca/           CLI entrypoint + command registration
internal/
  api/              HTTP/WebSocket API server
  banner/           ASCII art logo
  breakdown/        Goal -> task breakdown
  config/           YAML config and defaults
  driver/           Pluggable AI tool driver interface
  evaluate/         Task complexity evaluation
  executor/         Batch task execution (RunBatch)
  explore/          Codebase exploration + staleness
  integrator/       Merge and validation
  interaction/      LLM interaction persistence (tokens, cost, diffs)
  llm/              JSON extraction from LLM output
  logging/          Rotating log writer + querying
  mcp/              MCP server tool handlers/schemas
  model/            LLM model aggregation from drivers
  monitor/          Runtime monitors
  nullable/         Nil-safe pointer utils
  orchestrator/     Supervisor agent bootstrap
  plan/             Implementation plan generation
  procutil/         Process/git utilities
  pty/              Interactive terminal sessions
  quality/          Quality gates
  recovery/         Startup recovery + graceful shutdown
  review/           Review flows
  state/            SQLite migrations + watcher
  task/             Task store + dependency graph
  worker/           Worker adapter
  worktree/         Worktree lifecycle
prompts/            Prompt templates
web/                React + Vite frontend
```

## License

[MIT](LICENSE)
