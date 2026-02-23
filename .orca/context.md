Here's the context document:

---

# ORCA — Codebase Context

## Project Overview

Orca is a multi-agent software development orchestration system: it breaks goals into tasks, assigns them to isolated git worktrees, executes them via headless CLI tools (e.g. Claude Code), then reviews, quality-gates, and merges the results back automatically.

---

## Directory Structure

```
orca/
├── cmd/orca/           # Cobra CLI entry point + command impls
├── internal/           # All business logic (26 packages)
│   ├── api/            # HTTP + WebSocket server (16 handler files)
│   ├── config/         # YAML config loading, defaults
│   ├── state/          # SQLite DB, schema migrations, change watchers
│   ├── task/           # Task CRUD, dependency graph, cycle detection
│   ├── sprint/         # Sprint Planner + Executor (orchestration core)
│   ├── worker/         # CLI tool execution (headless + interactive)
│   ├── worktree/       # Git worktree create/list/clean
│   ├── integrator/     # Merge branches, conflict resolution, validation
│   ├── review/         # LLM-powered code review
│   ├── quality/        # Scope check, test delta analysis
│   ├── monitor/        # Stuck detection, budget enforcement
│   ├── mcp/            # Stdio JSON-RPC server (30+ MCP tools)
│   ├── orchestrator/   # Supervisor agent launcher + MCP config gen
│   ├── decompose/      # Goal → task decomposition via LLM
│   ├── plan/           # Implementation plan generation
│   ├── explore/        # Codebase exploration via LLM
│   ├── evaluate/       # Task complexity scoring
│   ├── cost/           # Token/cost tracking + parsing
│   ├── llm/            # Low-level LLM invocation helpers
│   ├── pty/            # PTY session management
│   └── ops/            # Operation tracking store
├── web/                # React 19 + Vite frontend (TypeScript)
│   ├── src/
│   │   ├── components/ # UI components
│   │   ├── hooks/      # React Query hooks for API/WS
│   │   └── pages/      # Route-level views
│   └── package.json
├── prompts/            # LLM prompt templates
├── tasks/              # Orca's own task tracking (dogfood)
├── .orca/              # Generated project config + logs
├── Taskfile.yml        # Build automation
├── go.mod              # Go 1.25 module
└── README.md
```

---

## Key Patterns

### Architecture

Layered, with clear boundaries:

```
CLI (Cobra)
  → Runtime (config + DB + executor init)
    → Sprint Executor (parallel workers on worktrees)
      → Quality Gates (scope, test delta, LLM alignment)
        → Integrator (git merge + validate)
          → API/WebSocket (real-time UI + MCP clients)
```

No direct LLM API calls in Go — all LLM interaction wraps CLI tools (e.g. `claude`). The MCP server exposes 30+ tools for LLM orchestrators to call back into Orca.

### Task State Machine

```
pending → in_sprint → review → approved | failed → merged
```

`GetReady()` returns tasks whose all deps are `merged`. Cycle detection uses DFS.

### Sprint Lifecycle

```
planning → running → reviewing → integrating → completed
```

Each sprint: select ready tasks → assign to git worktrees → run workers in parallel → LLM review → quality check → merge sequentially.

### Worker Abstraction

`Worker` interface: `Execute(ctx, taskID, prompt, worktreePath) error`

- **Headless adapter**: rewrites CLI args at execution time, streams stdout/stderr as `OutputLine` events
- **Interactive adapter**: PTY-based for human-in-the-loop

### Integration Pipeline

1. Merge branch with `--no-ff`
2. On conflict → rebase in worktree, retry merge
3. Fallback → rebase in main repo
4. Run validation commands post-merge

### Error Handling

- All errors wrapped with context: `fmt.Errorf("description: %w", err)`
- DB ops use transactions with `defer tx.Rollback()`
- Context timeouts propagate via `context.WithTimeout`
- Structured logging via `slog` → JSON to `.orca/orca.log` (rotating, 50MB default)
- API errors use JSON-RPC format (MCP), plain JSON (REST)

### Naming Conventions

| Scope | Convention |
|---|---|
| Packages | lowercase, descriptive (`task`, `sprint`, `integrator`) |
| Functions | Verb-first (`CreateTask`, `GetReady`, `HasCycle`) |
| Vars | Short: `t`, `s`, `db`, `cfg`, `ctx`, `err` |
| Constants | UPPERCASE for statuses, `defaultX` for defaults |
| Log keys | `"snake_case.dotted"` style (`"runtime.initialized"`) |

### Configuration Hierarchy

Embedded defaults → `.orca/orca.yaml` → tool-level overrides → phase-level overrides → CLI flags

### State Persistence

- SQLite with WAL mode, FK enforcement enabled
- 8 versioned schema migrations via `meta` table
- Watcher pattern: DB changes broadcast to WebSocket clients via channels

### Git Integration

- Per-task worktrees: `orca/task-{id}--{title-slug}`
- Integration branch: `orca/integration`
- Base branch: `main` (configurable)

---

## Dependencies

### Go

| Dep | Purpose |
|---|---|
| `spf13/cobra` | CLI framework |
| `mattn/go-sqlite3` | SQLite (CGO) |
| `gorilla/websocket` | WebSocket server |
| `creack/pty` | PTY session management |
| `gopkg.in/yaml.v3` | Config parsing |
| `google/uuid` | Task/sprint ID generation |
| `charmbracelet/*` | TUI components (bubbles, huh, lipgloss) |

### Web (TypeScript)

| Dep | Purpose |
|---|---|
| `react` 19 | UI framework |
| `@tanstack/react-query` | Server state management |
| `@tanstack/react-form` | Form management |
| `tailwindcss` 4 | Styling |
| `vite` 7 | Build tool + dev server |
| `xterm` | Terminal emulation in browser |
| `lucide-react` | Icons |

Runtime: `bun` (frontend package manager + dev server)

---

## Build / Test

```bash
# Full build (web then Go binary)
task build

# Go only (requires web already built)
task build:go

# Frontend dev server (proxies /api, /ws to Go backend)
task web:dev

# Tests
task test           # go test ./cmd/... ./internal/...
task vet            # go vet
task lint           # vet + build check

# Cleanup
task clean          # removes dist/ and web/dist/
```

Run locally: `go run ./cmd/orca [command]`

Key CLI commands: `start`, `sprint`, `task`, `integrate`, `serve`, `mcp`

---

## What to Know Before Contributing

1. **No direct LLM calls in Go** — always via CLI tool subprocess; configure in `.orca/orca.yaml` under `tool`
2. **SQLite is the source of truth** — all state flows through `internal/state`; add columns via numbered migrations
3. **Worktrees are disposable** — never assume a worktree exists; always check and recreate
4. **MCP tools are the extension point** — adding capabilities for LLM orchestrators means adding handlers in `internal/mcp/`
5. **Frontend talks WebSocket** — `internal/api` serves both REST and WS; changes to task/sprint state auto-broadcast via the watcher