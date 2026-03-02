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
Post-completion phase: `approved/merged → retro → memory sync` (automatic after merge, also available via CLI/MCP/API).
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
- RAG memory system: explore and retro extract reusable patterns, pitfalls, preferences, conventions, architecture, and dependency insights
- Memory-informed planning with FTS5/BM25 retrieval
- Provenance-aware memory lifecycle (provenance hashes, supersession, confidence reinforcement/decay)
- Auto-explore on `orca init` (cold-start context + seeded memory)
- Post-merge automation: retro per merged task, then memory sync
- Git-aware memory sync with commit-walking + diff magnitude classification (`minor|medium|major|deleted|renamed`)
- Lazy stale-memory refresh during retrieval (only queried stale entries are refreshed)
- Sync health surfaces in API/UI/MCP (`/status`, memory page banner, `memory_status`)
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
orca costs                   [--run]
orca ops                     [--all]
orca cleanup                 [--dry-run]
```

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
- Git sync uses commit-walking + diff magnitude classification (`orca memory sync`, `POST /api/v1/memory/sync`, MCP `memory_sync`).
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

## MCP

`orca mcp` exposes MCP tools for task orchestration:

- **Task lifecycle:** `tasks_list`, `tasks_get`, `tasks_create`, `tasks_update`, `tasks_delete`, `tasks_add_dependency`
- **Planning:** `breakdown`, `tasks_plan_generate`, `tasks_plan_evaluate`, `tasks_approve_plan`, `tasks_request_plan_changes`
- **Execution:** `tasks_start`, `tasks_stop`, `tasks_resume`
- **Review/integration:** `tasks_approve`, `tasks_request_changes`, `ai_review`, `tasks_reviews`, `merge`, `tasks_merge`
- **Retro:** `tasks_retro`
- **Memory:** `memory_list`, `memory_get`, `memory_search`, `memory_query`, `memory_update`, `memory_delete`, `memory_sync`, `memory_refresh`, `memory_status`
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
  explore/          Codebase exploration + explore memory seeding
  integrator/       Merge and validation
  interaction/      LLM interaction persistence (tokens, cost, diffs)
  memory/           RAG memory store + FTS5 search + git sync + retrieval + refresh
  diffclass/        Git diff magnitude classification for memory sync
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
