# Orca

Multi-agent CLI orchestrator for AI coding tools. Orca coordinates Claude Code, Codex, Aider, and similar CLI agents on shared codebases using git worktrees and direct task execution.

## How It Works

Orca wraps existing AI CLI tools as workers (no direct LLM API coupling).

1. `explore` — generate/refresh codebase context
2. `breakdown` — decompose goals into dependency-aware tasks
3. `tasks plan` / `tasks evaluate` — refine task implementation plans
4. `run` — execute ready tasks directly (parallel, isolated worktrees)
5. `review` — approve or request changes
6. `merge` — merge approved tasks into integration branch

Task flow: `pending → running → review → approved → merged`.

## Features

- Tool-agnostic worker execution
- Git worktree isolation per task branch (`orca/task-{id}`)
- Quality gates + review loop (`review request-changes` re-runs task)
- Cost tracking per run (`run_id`) and per tool
- Web UI with live status/events
- Task table UI (sortable/filterable) with task detail modal + review panel
- MCP server for agentic orchestration
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

# Add or decompose work
orca tasks add "Implement user authentication"
orca breakdown "Add rate limiting and retry safety across API clients"

# Run ready tasks directly
orca run

# Review outcomes
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
orca init
orca explore [--check|--manual <file>|--stdin|--tool <tool>]
orca breakdown "goal" [--tool <tool>] [--auto]

orca tasks
orca tasks add "title" [--description ...] [--depends-on ...] [--tool ...] [--model ...]
orca tasks list
orca tasks show <id>
orca tasks edit <id>
orca tasks delete <id>
orca tasks reopen <id...>
orca tasks evaluate <id> [--tool ...] [--model ...] [--json]
orca tasks plan <id> [--save] [--edit] [--tool ...] [--model ...]
orca tasks merge <id>

orca run [task-id...]
orca run --no-merge

orca review approve <id>
orca review request-changes <id> "feedback"

orca merge [--dry-run]
orca status
orca costs [--run <run-id-prefix>]
orca ops [--all]
orca cleanup
orca logs [--level ... --task ... --since ... --tail ... --follow --json]
orca models
orca config show
orca serve [--addr <addr>] [--orchestrator]
orca mcp
orca orc
```

## MCP

`orca mcp` exposes MCP tools for task orchestration, including:

- Task lifecycle: `tasks_list`, `tasks_get`, `tasks_create`, `tasks_update`, `tasks_delete`, `tasks_reopen`, `tasks_add_dependency`
- Planning: `breakdown`, `tasks_plan_evaluate`, `tasks_plan_generate`
- Execution: `tasks_run`
- Review/integration: `tasks_approve`, `tasks_request_changes`, `merge`, `tasks_merge`

## Project Structure

```text
cmd/orca/           CLI entrypoint + command registration
internal/
  api/              HTTP/WebSocket API server
  cost/             Cost tracking and summaries
  decompose/        Goal -> task decomposition
  evaluate/         Task complexity evaluation
  executor/         Batch task execution (RunBatch)
  explore/          Codebase exploration + staleness
  integrator/       Merge and validation
  mcp/              MCP server tool handlers/schemas
  monitor/          Runtime monitors
  ops/              Operation tracking
  plan/             Implementation plan generation
  quality/          Quality gates
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
