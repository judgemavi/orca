# Orca — Codebase Context

## Project Overview

Orca is a **multi-agent CLI orchestrator** for AI coding tools (Claude Code, Codex, Aider). It coordinates multiple AI workers on shared codebases using git worktree isolation and a scrum-inspired execution model: explore → decompose → sprint → review → integrate. Ships as a single Go binary with an embedded React dashboard and SQLite state.

---

## Directory Structure

```
orca/
├── cmd/orca/                  # CLI entry point
│   ├── main.go                # Runtime state, command registration, lifecycle
│   └── commands/              # 14 command modules (task, sprint, integrate, etc.)
│
├── internal/                  # Core business logic (23 packages)
│   ├── state/                 # SQLite persistence (schema, migrations, change watcher)
│   ├── task/                  # Task CRUD & dependency graph (Store: 16 methods)
│   ├── config/                # YAML config parsing + embedded defaults
│   ├── sprint/                # Planning, execution, monitoring
│   ├── worker/                # CLI tool adapter (headless/interactive/resume modes)
│   ├── explore/               # Codebase analysis via headless LLM
│   ├── decompose/             # Goal → task breakdown via LLM
│   ├── integrator/            # Branch merging, conflict resolution, validation
│   ├── review/                # Automated code review + alignment checks
│   ├── quality/               # Pre-review gates (scope creep, test delta)
│   ├── monitor/               # Stuck detection, conflict prediction, budget enforcement
│   ├── cost/                  # Per-sprint/tool cost tracking & token parsing
│   ├── llm/                   # LLM utilities (JSON/markdown extraction)
│   ├── mcp/                   # MCP stdio server (30+ tools, JSONRPC 2.0)
│   ├── orchestrator/          # Supervisor agent bootstrap & MCP config
│   ├── plan/                  # Task implementation planning via LLM
│   ├── api/                   # HTTP/WebSocket server (React dashboard backend)
│   ├── pty/                   # Interactive terminal session management
│   ├── ops/                   # Operation audit log
│   ├── worktree/              # Git worktree lifecycle (create/delete/checkout)
│   ├── model/                 # Tool model catalog
│   ├── testutil/              # Shared test fixtures
│   └── banner/                # ASCII art init wizard
│
├── prompts/                   # LLM prompt templates (.md files + loader)
│   ├── explore.md, decompose.md, plan.md, review.md
│   ├── orchestrator.md, alignment.md, conflict_resolve.md
│   └── prompts.go             # Template loading
│
├── web/                       # React 19 frontend (embedded in binary)
│   ├── src/
│   │   ├── components/        # board/ (Kanban), console/ (diff viewer), terminal/ (xterm)
│   │   ├── hooks/             # React Query integration
│   │   ├── api.ts             # Fetch wrapper + WebSocket client
│   │   ├── types.ts           # TypeScript models
│   │   └── App.tsx            # Root component
│   └── vite.config.ts
│
├── .orca/                     # Runtime state (generated, gitignored)
│   ├── orca.yaml              # Project config
│   ├── state.db               # SQLite (WAL mode)
│   ├── context.md             # Explore output
│   ├── mcp.json               # MCP config for tool processes
│   └── worktrees/             # Per-task git worktrees
│
├── Taskfile.yml               # Build orchestration (task runner)
├── go.mod / go.sum            # Go deps
└── PLAN.md                    # Feature roadmap
```

---

## Key Patterns

### Architecture: Scrum-Inspired Pipeline

```
Explore → Decompose → Sprint Plan → Sprint Execute → Review → Integrate
```

Each stage is a CLI command and an internal package. Tasks flow through statuses:

```
pending → in_sprint → running → review → approved → merged
                              ↘ failed (can reopen)
```

Sprints: `planning → in_progress → in_review → finalized`

### Worker Adapter Pattern

`worker.Adapter` wraps any CLI tool with two modes:
- **Headless**: binary + args template (`{{prompt}}` substitution) → stdout capture
- **Interactive**: MCP-based with session resume support

Output extraction is configurable per-tool: `json_envelope`, `stdout`, or `regex`.

### Git Worktree Isolation

- One branch per task: `orca/task-{id}`
- Integration branch: `orca/integration` (not main)
- Merge with `--no-ff`, auto-rebase on conflict

### Change Detection

SQLite triggers increment `meta.db_version` on every write. Watcher polls this sentinel (O(1), no table scans) → emits events → WebSocket broadcasts to dashboard.

### Error Handling

- Wrapped errors: `fmt.Errorf("operation: %w", err)`
- No panics in user-facing code
- Graceful degradation (missing context → empty string)
- Orphan detection for hung tasks (resume or cleanup)

### Naming Conventions

| Scope | Convention |
|-------|-----------|
| Go files | `snake_case.go` |
| Functions | `PascalCase` (exported) / `camelCase` (private) |
| DB tables | `snake_case` |
| Branches | `orca/task-{uuid}`, `orca/integration` |

---

## Database Schema (SQLite, WAL mode)

8 tables + triggers, versioned migrations (v1–v8):

| Table | Purpose |
|-------|---------|
| `tasks` | Task entries (id, title, status, sprint_id, parent_id, prompt, phase_config) |
| `task_deps` | Dependency graph (task_id → depends_on) |
| `task_reviews` | Review feedback (status: pending/addressed) |
| `sprints` | Sprint batches (status: planning/in_progress/in_review/finalized) |
| `artifacts` | Task outputs (diff, stdout, stderr, exit_code, duration_ms, quality_json) |
| `costs` | Budget tracking (tool, input/output tokens, estimated_cost) |
| `operations` | Audit log (type, target_id, status, result, error) |
| `sessions` | Interactive PTY sessions (tool, pid, working_dir, status) |
| `meta` | Sentinel for change detection (db_version) |

---

## Dependencies

### Go (Direct)

| Package | Purpose |
|---------|---------|
| `creack/pty` | PTY allocation for interactive sessions |
| `google/uuid` | UUID generation (task/sprint IDs) |
| `gorilla/websocket` | WebSocket for live dashboard |
| `mattn/go-sqlite3` | SQLite driver |
| `spf13/cobra` | CLI framework |
| `gopkg.in/yaml.v3` | Config parsing |
| `charmbracelet/*` | TUI components (bubbles, lipgloss, huh) |

### Frontend (Node/Bun)

| Package | Purpose |
|---------|---------|
| `react@19` | UI framework |
| `@tanstack/react-query@5` | Server state management |
| `@xterm/xterm@6` | Terminal emulation |
| `@dnd-kit/*` | Drag-and-drop (Kanban board) |
| `react-diff-viewer-continued` | Diff rendering |
| `tailwindcss@4` | Styling |
| `vite@7` | Bundler |
| `@biomejs/biome` | Linter/formatter (dev) |

---

## Build & Test

### Build (uses [Task](https://taskfile.dev))

```bash
task build          # Full build: web + Go binary → dist/orca
task build:go       # Go binary only: go build -o dist/orca ./cmd/orca
task web:build      # Frontend: tsc + vite → web/dist/ (embedded in Go binary)
task web:dev        # Frontend dev server on :5173
task clean          # rm -rf dist/ web/dist/
```

Output: single `dist/orca` binary with embedded React frontend and SQLite.

### Test

```bash
task test           # go test ./cmd/... ./internal/...
task vet            # go vet
task lint           # vet + build
```

Go stdlib `testing` package. Key test areas: state migrations, worker output extraction, sprint planning, monitor algorithms.

### Run

```bash
orca init                              # Setup .orca/ dir + config
orca explore --goal "Add auth"         # Generate codebase context
orca breakdown "Implement JWT auth"    # Decompose goal → tasks
orca sprint plan                       # Select ready tasks
orca sprint start                      # Execute workers in parallel
orca sprint review                     # Quality gates + review
orca integrate                         # Merge approved → integration branch
orca serve                             # Web dashboard on :8080
orca mcp                               # Start MCP stdio server
```

---

## CLI Commands

| Group | Commands |
|-------|----------|
| Setup | `init`, `explore`, `status`, `log` |
| Tasks | `task add/edit/delete/list/show/reopen/merge/plan` |
| Sprint | `sprint plan/assign/unassign/start/status/review/resume/cancel/reset` |
| Review | `review approve/request-changes` |
| Execute | `run`, `integrate`, `breakdown` |
| Server | `serve` (HTTP/WS :8080), `mcp` (stdio JSONRPC) |
| Meta | `config show`, `models`, `costs`, `ops` |

---

## Configuration (`.orca/orca.yaml`)

```yaml
project:
  name: orca
  integration_branch: orca/integration
  worktree_dir: .orca/worktrees

tools:
  claude:
    binary: claude
    model: claude-opus-4-6
    headless_args: [-p, '{{prompt}}', --output-format, json, ...]
    interactive_args: [--mcp-config, '{{mcp_config}}', ...]
    resume_args: [--resume, '{{session_id}}', ...]
    timeout: 600s
    output:
      mode: json_envelope    # json_envelope | stdout | regex
      result_field: result

defaults:
  tool: claude

workers:
  max_parallel: 3            # Concurrent task workers

validation:
  commands: []               # Post-integration test commands

quality:
  enabled: true
  scope_check: true          # Detect scope creep
  test_delta: true           # Validate test coverage
  alignment_check: false     # LLM alignment verification

monitor:
  stuck_check_interval: 30s
  max_stuck_cycles: 3
  conflict_check_interval: 15s

server:
  addr: :8080
```

---

## Key Algorithms

**Staleness check (explore)**: SHA256 of `git ls-files` output → compare with cached hash → skip regeneration if unchanged.

**Stuck detection**: SHA256 of worktree file tree, compared every N seconds. If unchanged for `max_stuck_cycles` → emit stuck event.

**Conflict prediction**: Intersect files in task diff with files in integration branch diff → warn if overlap exceeds threshold.

**Scope creep**: Flag if files changed > threshold or lines > 500 (non-refactor), or if no tests added with >3 non-test files changed.

**Sprint planning**: `GetReady()` finds tasks with all deps satisfied → batch up to `max_parallel` → create sprint.

**Integration ordering**: Sort approved tasks by priority DESC → category (scaffold > config > migration > feature) → created_at ASC. Merge sequentially with validation gate after each.

---

## MCP Server (30+ tools)

Accessible via `orca mcp` (stdio JSONRPC 2.0). Key tool groups:

- **Task mgmt**: `task_list`, `task_create`, `task_update`, `task_delete`
- **Sprint ops**: `sprint_plan`, `sprint_start`, `sprint_status`
- **Review**: `review_task`, `approval_status`
- **Integration**: `integrate`, `merge_status`
- **Orchestration**: `breakdown`, `explore`, `plan_task`

Config for external tools:
```json
{
  "mcpServers": {
    "orca": { "command": "/path/to/orca", "args": ["mcp"], "cwd": "/path/to/repo" }
  }
}
```

---

## Frontend Architecture

- **React Query** for server state (tasks, sprints, artifacts)
- **WebSocket** for live updates (board broadcasts)
- **Components**: Kanban board (`@dnd-kit`), diff viewer, xterm.js terminal, sidebar nav
- **Dev**: `task web:dev` → Vite on :5173, proxies API to :8080
