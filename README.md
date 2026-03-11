# Orca

Multi-agent CLI orchestrator for AI coding tools. Orca coordinates Claude Code, Codex, Aider, and similar CLI agents on shared codebases using git worktrees and direct task execution.

## How It Works

Orca wraps existing AI CLI tools as workers (no direct LLM API coupling).

1. `init` — initialize project state and run initial explore automatically
2. `breakdown` — break goals into dependency-aware tasks
3. `tasks plan` / `tasks evaluate` — refine task implementation plans
4. `start` — execute ready tasks directly (parallel, isolated worktrees)
5. `review` — approve, request changes, or run AI review
6. `merge` — merge approved tasks into integration branch
7. `retro + sync` — post-merge automation extracts memory and syncs staleness

Task flow: `pending → planned → running → review → approved → merged`.
Post-completion: `approved/merged → retro → memory sync` (automatic after merge, also available via CLI/API).
Breakdown branch: `pending → broken_down` (when a parent task is split into child tasks).
Stop path: `running → stopped` (via `tasks_stop`); `stopped → running` (resume via `tasks_resume`).
Failure path: `running → failed`.

Orca handles crashes gracefully: SIGINT/SIGTERM triggers orderly shutdown (cancel workers, mark in-flight interactions failed, set running tasks to stopped). On next launch, automatic startup recovery detects and resets any stale state left by hard kills (SIGKILL, OOM, power loss).

## Features

- Tool-agnostic worker execution via pluggable drivers
- Git worktree isolation per task branch (`orca/task-{id}`)
- Plan review loop (`tasks approve-plan` / `tasks request-plan-changes`)
- Review loop (`review request-changes` re-runs task, `review ai` runs automated AI review)
- Interaction-based tracking: tokens, cost, diffs, and quality per LLM invocation
- Web UI with live status/events via WebSocket
- Task table, interaction timeline, diff viewer, inline review, terminal console
- RAG memory system: explore and retro extract reusable patterns, pitfalls, preferences, conventions, architecture, and dependency insights
- Memory-informed planning with FTS5/BM25 retrieval
- Provenance-aware memory lifecycle (provenance hashes, supersession, confidence reinforcement/decay)
- Auto-explore on `orca init` (cold-start context + seeded memory)
- Post-merge automation: retro per merged task, then memory sync
- Git-aware memory sync with commit-walking + diff magnitude classification (`minor|medium|major|deleted|renamed`)
- Lazy stale-memory refresh during retrieval (only queried stale entries are refreshed)
- Sync health surfaces in API/UI (`/status`, memory page banner)
- Bun/TypeScript backend + React frontend monorepo

## Requirements

- Git
- At least one supported AI CLI tool: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), or [Aider](https://aider.chat)
- [Bun](https://bun.sh) (required)

## Installation

```bash
git clone https://github.com/jasjeetmavi/orca.git
cd orca
bun install
bun run build:web
bun run build:server
```

## Quick Start

```bash
# Initialize in a git repo
cd your-project
orca init

# Optional manual re-explore
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
  │                          [--disable-autorun <types>] [--enable-autorun <types>]
  ├── list
  ├── edit [id]              [--title] [--description] [--plan] [--status]
  │                          [--disable-autorun <types>] [--enable-autorun <types>]
  │                          [--reset-autorun [types|"all"]]
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
  └── logs <id>              [--type] [--attempt] [--raw] [-f] [--json]

orca review
  ├── approve [id]
  ├── request-changes [id] [feedback]  [--tool] [--model]
  └── ai [id]               [--tool] [--model] [--prompt]

orca merge                   [--dry-run]
orca serve                   [-p/--port] [--orchestrator]
orca memory
  ├── list                   [--category] [--tag] [--source-type] [--file] [--stale] [--covered-before] [--json]
  ├── show <id>
  ├── search <query>         [--limit] [--source-type] [--file] [--json]
  ├── query <query>          [--limit] [--json]
  ├── edit <id>              [--content] [--confidence] [--category]
  ├── delete <id>            [-y]
  ├── sync
  └── refresh [id]
orca orc
orca status
orca logs                    [--level] [--task] [--since] [--tail] [-f] [--json]
orca models [tool]
orca config show | set <key> <value>
orca ops                     [--all]
orca cleanup                 [--dry-run]
```

### Auto-Run

Auto-run is resolved in 3 levels: global `config.autoRun` → per-task `autoRunOverrides` → workflow step `autoRun` def → default `true`.

- **Global kill switch**: `orca config set autoRun false` disables all auto-run chaining
- **Per-task overrides**: control which steps auto-run for individual tasks
  - `--disable-autorun review,merge` — pause chain at review and merge for this task
  - `--enable-autorun review` — force auto-run review even if workflow def disables it
  - `--reset-autorun all` — clear all overrides, inherit from workflow/global
  - `--reset-autorun review,merge` — clear specific overrides
- **Workflow step defs**: custom workflows can set `autoRun: false` on individual steps

Comma-separated step names: `evaluate`, `plan`, `breakdown`, `code`, `review`, `merge`.

Note: `retro` and `explore` are system-controlled (gated by `memory.enabled`), not auto-run steps.

### Memory Config

```
memory:
  enabled: true    # global kill switch for retro, explore, and memory sync
  retro: true      # auto-run retro after merge
  sync: true       # auto-run memory sync after merge
```

When `memory.enabled` is `false`, explore/retro are blocked across all entrypoints (CLI and HTTP API).

### Schema Versioning

Config includes `schemaVersion` for safe migration. Orca errors on future versions (upgrade required) and auto-migrates old versions (e.g., v1 `postMerge.retro` → v2 `memory.retro`).

## Memory Lifecycle

| Source | Created by | Typical confidence | Invalidated by |
|--------|------------|--------------------|----------------|
| `explore` | `orca init` / `orca explore` | High (`~0.95`) | Sync marks stale/superseded when files structurally change or are deleted |
| `retro` | Post-merge retro (`tasks retro`, auto on merge) | LLM-assigned | Supersession, confidence decay, staleness from sync |

- Lifecycle flow:
  - `orca init` runs initial explore and seeds memory with a `project-summary` plus `explore-seed` entries.
  - Task merges run retro automatically per merged task.
  - One sync runs after merge to walk commits since `last_synced_commit`.
- Retrieval is budgeted in 4 layers: `project-summary`, file-path matches, FTS semantic matches, and sibling active tasks.
- Git sync uses commit-walking + diff magnitude classification (`orca memory sync`, `POST /api/v1/memory/sync`).
- Sync effects by change magnitude:
  - `minor` (<20 lines): decay confidence (`×0.95`) and bump `covered_at_commit`
  - `medium` (20-100 lines): decay confidence (`×0.85`) and bump `covered_at_commit`
  - `major` (>100 lines): decay confidence (`×0.70`) and mark entry `stale=1` (lazy refresh on retrieval)
  - `deleted`: supersede entry
  - `renamed`: update file path associations
- Explore seeding writes `explore` memory with `project-summary` / `explore-seed` tags and file associations, then supersedes older explore entries.
- Reinforcement rules: successful tasks (`review`) boost confidence for memory used during planning, failed tasks decay those same entries.
- Batch runs apply bulk confidence decay to stale, unused memory (with a floor).
- Retro/sync are idempotent; re-triggering after failures is safe.

## Memory API

- `GET /api/v1/memory` (supports `category`, `tag`, `source_type`, `file_path`, `stale`, `covered_before`, `q`, `limit`)
- `GET /api/v1/memory/{id}`
- `GET /api/v1/memory/query?q=...`
- `PATCH /api/v1/memory/{id}`
- `DELETE /api/v1/memory/{id}`
- `POST /api/v1/memory/sync`
- `POST /api/v1/memory/refresh` (optional body: `{"entry_id":"..."}`)
- `GET /api/v1/status` (includes `last_synced_commit`, `current_commit`, `sync_needed`, `commits_behind`)

## Project Structure

```text
server/                      Bun + TypeScript backend
  src/
    bootstrap.ts             Shared foundation (DB, stores, config, registry, queue, executor)
    entrypoints/
      cli.ts                 Short-lived CLI entrypoint
      serve.ts               Full stack: processor, recovery, HTTP/WS, shutdown
    api/                     HTTP routes + WebSocket
    cli/                     Commander subcommands
    store/                   SQLite stores (tasks, config, interactions, memory)
    executor/                Task execution engine
    domain/                  Business logic (review, plan, merge, recovery, etc.)
    queue/                   Job queue + processor
    prompts/md/              Prompt templates
web/                         React + Vite frontend
packages/types/              Shared API/domain types
```

## License

[MIT](LICENSE)
