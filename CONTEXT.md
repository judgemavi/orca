# Orca — Codebase Context

## Project Overview

Orca is a multi-agent CLI orchestrator for AI coding tools (Claude Code, Codex, Aider). It coordinates workers on shared codebases using git worktree isolation and a direct execution pipeline:

`explore → decompose → plan → run → review → merge`

Ready tasks run directly via `executor.RunBatch()`.

---

## Directory Structure

```text
orca/
├── cmd/orca/                  # CLI entrypoint and command modules
├── internal/
│   ├── api/                   # HTTP/WebSocket backend
│   ├── config/                # YAML config and defaults
│   ├── cost/                  # Token/cost tracking (run-scoped)
│   ├── decompose/             # Goal -> task breakdown
│   ├── evaluate/              # Task complexity evaluation
│   ├── executor/              # Direct task batch execution (RunBatch)
│   ├── explore/               # Codebase context generation
│   ├── integrator/            # Merge + validation
│   ├── mcp/                   # MCP stdio server tools
│   ├── monitor/               # Stuck/conflict/budget runtime monitors
│   ├── ops/                   # Operation audit log
│   ├── plan/                  # Implementation planning
│   ├── pty/                   # Interactive terminal sessions
│   ├── quality/               # Scope/test/alignment quality gates
│   ├── review/                # Automated review helpers
│   ├── state/                 # SQLite persistence + migrations + watcher
│   ├── task/                  # Task CRUD + dependency graph
│   ├── worker/                # CLI tool adapter/execution
│   └── worktree/              # Git worktree lifecycle
├── prompts/                   # Prompt templates used by phases/orchestrator
├── web/                       # Embedded React dashboard
└── .orca/                     # Runtime state (config/db/context/worktrees)
```

---

## Execution Model

### Pipeline

`Explore → Decompose → Plan → Run → Review → Merge`

### Task Status Flow

`pending → running → review → approved → merged`

Failure path: `running → failed` (can be reopened to `pending`).

### Run Semantics

- `orca run` (or `POST /api/v1/tasks/run`) selects ready tasks (or explicit IDs)
- Executor runs up to `workers.max_parallel`
- Each task runs in its own worktree branch (`orca/task-{id}`)
- Artifacts/costs are recorded with a `run_id`

---

## Database Schema

SQLite with migrations.

| Table | Purpose |
|---|---|
| `tasks` | Task records |
| `task_deps` | Task dependency graph |
| `task_reviews` | Review feedback history |
| `artifacts` | Execution outputs (`diff`, logs, exit code, quality), includes `run_id` |
| `costs` | Token/cost tracking, includes `run_id` |
| `operations` | Async operation audit log |
| `sessions` | PTY session metadata |
| `meta` | DB version sentinel for watcher |

---

## CLI Surface

Core commands:

- Setup/context: `init`, `explore`, `status`
- Planning/tasks: `breakdown`, `tasks add/list/show/edit/delete/reopen/plan/evaluate/merge`
- Execution: `run`, `review approve`, `review request-changes`, `merge`
- Runtime/ops: `serve`, `mcp`, `orc`, `ops`, `costs`, `cleanup`, `logs`, `models`, `config show`

Ready tasks execute directly via `executor.RunBatch()`.

---

## Key Algorithms

- Staleness check (`explore`): hash tracked files to detect context drift.
- Ready queue: `GetReady()` returns `pending` tasks whose dependencies are `merged`.
- Run execution: `executor.RunBatch()` transitions tasks to `running`, executes workers in parallel, stores artifacts/costs by `run_id`, then finalizes statuses.
- Integration ordering: merge approved tasks deterministically to reduce conflicts.

---

## MCP Server

Orca MCP (`orca mcp`) exposes task-oriented tools.

Key groups:

- Task lifecycle: `tasks_list`, `tasks_get`, `tasks_create`, `tasks_update`, `tasks_delete`, `tasks_reopen`, `tasks_add_dependency`
- Planning: `breakdown`, `tasks_plan_evaluate`, `tasks_plan_generate`
- Execution: `tasks_run`
- Review/integration: `tasks_approve`, `tasks_request_changes`, `merge`, `tasks_merge`
- Context/ops: `explore`, `explore_status`, `project_status`, `worktree_*`, `budget_status`, `quality_results`, `log_*`

---

## Frontend Architecture

- React Query for server state
- WebSocket events for live task/run updates
- Task table + task detail + terminal views for end-to-end execution visibility
