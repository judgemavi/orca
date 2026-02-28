# Orca — Codebase Context

## Project Overview

Orca is a multi-agent CLI orchestrator for AI coding tools (Claude Code, Codex, Aider). It coordinates workers on shared codebases using git worktree isolation and a direct execution pipeline:

`explore → breakdown → plan → start → review → merge`

Ready tasks run directly via `executor.RunBatch()`.

---

## Directory Structure

```text
orca/
├── cmd/orca/                  # CLI entrypoint and command modules
├── internal/
│   ├── api/                   # HTTP/WebSocket backend
│   ├── banner/                # ASCII art logo printing
│   ├── config/                # YAML config and defaults
│   ├── breakdown/             # Goal -> task breakdown
│   ├── driver/                # Pluggable AI tool driver interface (Claude, Codex, Aider)
│   ├── evaluate/              # Task complexity evaluation
│   ├── executor/              # Direct task batch execution (RunBatch)
│   ├── explore/               # Codebase context generation + staleness
│   ├── integrator/            # Merge + validation
│   ├── interaction/           # LLM interaction persistence (tokens, cost, diffs, logs)
│   ├── llm/                   # JSON extraction from LLM output
│   ├── logging/               # slog config, rotating file writer, log querying
│   ├── mcp/                   # MCP stdio server tools
│   ├── model/                 # Aggregates available LLM models from drivers
│   ├── monitor/               # Stuck/conflict runtime monitors
│   ├── nullable/              # Generic nil-safe pointer dereference
│   ├── orchestrator/          # Supervisor agent bootstrap (MCP config, launch args)
│   ├── plan/                  # Implementation planning
│   ├── procutil/              # Process/git utilities
│   ├── pty/                   # Interactive terminal sessions
│   ├── quality/               # Scope/test/alignment quality gates
│   ├── review/                # Automated review helpers
│   ├── state/                 # SQLite persistence + migrations + watcher
│   ├── task/                  # Task CRUD + dependency graph
│   ├── worker/                # CLI tool adapter/execution
│   └── worktree/              # Git worktree lifecycle
├── prompts/                   # Prompt templates used by phases/orchestrator
├── web/                       # Embedded React dashboard
└── .tasks/                    # Task spec files for pending UI work
```

---

## Execution Model

### Pipeline

`Explore → Breakdown → Plan → Start → Review → Merge`

### Task Status Flow

`pending → planned → running → review → approved → merged`

Breakdown branch: `pending → broken_down` (when a parent task is split into child tasks).

Stop path: `running → stopped` (via `tasks_stop`). `stopped → running` uses explicit session resume (`executor.ResumeTask`).

Failure path: `running → failed` (can be reopened to `pending`).

### Run Semantics

- `orca start` (or `POST /api/v1/tasks/start`, alias: `orca run`) selects ready tasks (or explicit IDs)
- Executor runs up to `workers.max_parallel`
- Each task runs in its own worktree branch (`orca/task-{id}`)
- Interactions are recorded with a `run_id` tracking tokens, cost, and diffs

---

## Database Schema

SQLite with versioned migrations (currently V3). WAL mode + foreign keys enabled.

| Table | Purpose |
|---|---|
| `tasks` | Task records (id, title, description, plan, status, parent_id, session_id) |
| `task_deps` | Task dependency graph (task_id, depends_on) |
| `task_reviews` | Review feedback history, linked to interactions |
| `task_interactions` | LLM interaction logs: phase, attempt, run_id, tool, model, tokens, cost, diff, quality, duration |
| `sessions` | PTY session metadata (tool, pid, status, terminal size) |
| `config` | Key-value runtime config store |
| `meta` | DB version sentinel for watcher (auto-incremented by triggers) |

### Key: task_interactions

Central tracking table replacing the old artifacts/costs model. Each row records one LLM invocation:
- **Phases:** explore, breakdown, plan, evaluate, run, revise, review, merge
- **Tracking:** input_tokens, output_tokens, estimated_cost, duration_ms, exit_code
- **Outputs:** diff, quality_json, error, log_path

---

## CLI Surface

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

---

## Key Algorithms

- Staleness check (`explore`): hash tracked files to detect context drift.
- Ready queue: `GetReady()` returns `pending` tasks whose dependencies are `merged`.
- Run execution: `executor.RunBatch()` transitions tasks to `running`, executes workers in parallel, stores interactions by `run_id`, then finalizes statuses.
- Integration ordering: merge approved tasks deterministically to reduce conflicts.

---

## MCP Server

Orca MCP (`orca mcp`) exposes 35 tools for task orchestration.

### Task Lifecycle
`tasks_list`, `tasks_get`, `tasks_create`, `tasks_update`, `tasks_delete`, `tasks_add_dependency`

### Planning
`breakdown`, `tasks_plan_generate`, `tasks_plan_evaluate`, `tasks_approve_plan`, `tasks_request_plan_changes`

### Execution
`tasks_start` (`tasks_run` alias), `tasks_stop` (`tasks_cancel` alias), `tasks_resume`

### Review & Integration
`tasks_approve`, `tasks_request_changes`, `ai_review`, `tasks_reviews`, `merge`, `tasks_merge`

### Interactions
`interactions_list`, `interaction_get`

### Project & Config
`project_status`, `config_get`, `config_update`, `models_list`

### Context
`explore`, `explore_status`

### Worktree
`worktree_cleanup`, `worktree_status`

### Monitoring
`cost_status`, `quality_results`, `log_event`, `log_query`

---

## Frontend Architecture

React 19 + Vite 7 + TanStack Router/Query + Tailwind CSS 4.

- **Task table** — filterable/sortable list with status badges, run/merge toolbar actions
- **Task detail** — 3-phase visual timeline (planning → execution → merge) with collapsible interaction logs, inline review actions, diff viewer
- **Terminal** — xterm.js console panel for live CLI sessions
- **Review** — inline approve/request-changes, AI review result cards
- **Diff viewer** — file-by-file tabbed diff comparison
- **Operations indicator** — live status of running operations (plan, run, merge, etc.)
- **WebSocket bridge** — React Query cache invalidation via 20+ real-time event types
