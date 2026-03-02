# Orca

Multi-agent CLI orchestrator for AI coding tools. Orca coordinates Claude Code, Codex, Aider, and similar CLI agents on shared codebases using git worktrees and direct task execution.

## How It Works

Orca wraps existing AI CLI tools as workers (no direct LLM API coupling).

1. `explore` — generate/refresh codebase context
2. `breakdown` — break goals into dependency-aware tasks
3. `tasks plan` / `tasks evaluate` — refine task implementation plans
4. `start` — execute ready tasks directly (parallel, isolated worktrees)
5. `review` — approve, request changes, or run AI review
6. `retro` — extract reusable memory from approved/merged tasks
7. `merge` — merge approved tasks into integration branch

Task flow: `pending → planned → running → review → approved → merged`.
Post-completion phase: `approved/merged → retro` (memory extraction via CLI/MCP/API).
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
- RAG memory system: retro and explore extract reusable patterns, pitfalls, preferences, conventions, architecture, and dependency insights
- Memory-informed planning with FTS5/BM25 retrieval
- Provenance-aware memory lifecycle (provenance hashes, supersession, confidence reinforcement/decay)
- Git-aware memory sync for staleness detection by changed file paths
- MCP server for agentic orchestration (task, planning, review, memory, and ops tools)
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
orca start [task-ids...]     [--no-merge]

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
  ├── retro [id]             [--tool] [--model] [--json]
  ├── reviews [id]
  └── logs <id>              [--phase] [--attempt] [--raw] [-f] [--json]

orca review
  ├── approve [id]
  ├── request-changes [id] [feedback]  [--tool] [--model]
  └── ai [id]               [--tool] [--model] [--prompt]

orca merge                   [--dry-run]
orca serve                   [-p/--port] [--orchestrator]
orca mcp
orca memory
  ├── list                   [--category] [--tag] [--source-type] [--file] [--json]
  ├── show <id>
  ├── search <query>         [--limit] [--source-type] [--file] [--json]
  ├── edit <id>              [--content] [--confidence] [--category]
  └── delete <id>            [-y]
  └── sync
orca orc
orca status
orca logs                    [--level] [--task] [--since] [--tail] [-f] [--json]
orca models [tool]
orca config show | set <key> <value>
orca costs                   [--run]
orca ops                     [--all]
orca cleanup                 [--dry-run]
```

## Memory Lifecycle

| Source | Created by | Confidence | Decay | Invalidated by |
|--------|------------|------------|-------|----------------|
| `retro` | Retro phase (`tasks retro`) | LLM-assigned | Batch decay + git sync (`x0.8`) | Supersession, confidence floor |
| `task` | Explore seeding (`explore`) | Typically high (`~0.95`) | Batch decay + git sync (`x0.9`) | Superseded by newer explore seeds |
| `commit` | Manual/future commit-linked memory | High | Not auto-decayed by sync | Superseded when affected files change |

- Git sync uses `last_synced_commit` and changed-file matching to flag stale memory (`orca memory sync`, `POST /api/v1/memory/sync`, MCP `memory_sync`).
- Explore seeding writes new `task` memory with `explore-seed` tags and file associations, then supersedes older explore-seeded entries.
- Reinforcement rules: successful tasks (`review`) boost confidence for memory used during planning, failed tasks decay those same entries.
- Batch runs apply bulk confidence decay to stale, unused memory (with a floor).

## Memory API

- `GET /api/v1/memory` (supports `category`, `tag`, `source_type`, `file_path`, `q`, `limit`)
- `GET /api/v1/memory/{id}`
- `PATCH /api/v1/memory/{id}`
- `DELETE /api/v1/memory/{id}`
- `POST /api/v1/memory/sync`

## MCP

`orca mcp` exposes MCP tools for task orchestration:

- **Task lifecycle:** `tasks_list`, `tasks_get`, `tasks_create`, `tasks_update`, `tasks_delete`, `tasks_add_dependency`
- **Planning:** `breakdown`, `tasks_plan_generate`, `tasks_plan_evaluate`, `tasks_approve_plan`, `tasks_request_plan_changes`
- **Execution:** `tasks_start`, `tasks_stop`, `tasks_resume`
- **Review/integration:** `tasks_approve`, `tasks_request_changes`, `ai_review`, `tasks_reviews`, `merge`, `tasks_merge`
- **Retro:** `tasks_retro`
- **Memory:** `memory_list`, `memory_get`, `memory_search`, `memory_update`, `memory_delete`, `memory_sync`
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
  memory/           RAG memory store + FTS5 search + git sync
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
  retro/            Post-task retrospective extraction
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
