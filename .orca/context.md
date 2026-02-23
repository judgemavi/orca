Here's the context document:

---

# Orca — Codebase Context

## Project Overview

Orca is a multi-agent CLI orchestrator that coordinates AI coding tools (Claude Code, Codex, Aider) on shared codebases. It uses git worktree isolation and a scrum-inspired execution model (explore → plan → sprint → review → integrate) without calling LLM APIs directly — it wraps existing CLI agents as workers.

---

## Directory Structure

```
orca/
├── cmd/orca/              # CLI entry point + 13 command files (Cobra)
│   └── commands/          # context, explore, integrate, logs, mcp, plan,
│                          #   review, run, serve, sprint, task, helpers, misc
├── internal/              # Core packages (26 total)
│   ├── api/               # HTTP + WebSocket handlers (18 files)
│   ├── config/            # Config loading, defaults.yaml, validation
│   ├── cost/              # Per-task/sprint cost tracking
│   ├── decompose/         # Goal → task decomposition via LLM
│   ├── explore/           # Codebase analysis phase
│   ├── integrator/        # Branch merge + conflict resolution
│   ├── llm/               # LLM adapter (prompt execution, extraction)
│   ├── mcp/               # 30 MCP tools for autopilot mode
│   ├── model/             # Core data models (Task, Sprint, etc.)
│   ├── monitor/           # Stuck detection, budget enforcement, conflict prediction
│   ├── ops/               # Operations management
│   ├── orchestrator/      # Main execution engine
│   ├── plan/              # Planning phase
│   ├── pty/               # Pseudo-terminal (streams worker output)
│   ├── quality/           # Gates: scope_check, test_delta, alignment
│   ├── review/            # Diff review + alignment verification
│   ├── sprint/            # Sprint lifecycle management
│   ├── state/             # SQLite-backed state + file watchers
│   ├── task/              # Task CRUD + status transitions
│   ├── worker/            # Worker pool (configurable parallelism)
│   └── worktree/          # Git worktree create/cleanup
├── web/                   # React 19 + TailwindCSS 4 frontend (Vite/Bun)
│   └── src/
│       ├── components/    # board/, blocks/, common/, console/, terminal/
│       ├── hooks/         # queries/ (TanStack Query), forms/
│       ├── lib/           # queryClient, wsQueryBridge, logParser
│       ├── api.ts         # Typed API client
│       └── ws.ts          # WebSocket client
├── prompts/               # Markdown system prompts (decompose, plan, review, etc.)
├── dist/                  # Build output (single binary with embedded web)
├── Taskfile.yml           # Build/test/lint tasks
├── go.mod                 # Go 1.25.3, module: github.com/jasjeetmavi/orca
└── .orca/orca.yaml        # Runtime config (workers, phases, cost, monitoring)
```

---

## Key Patterns

**Architecture**
- Orchestrator drives a state machine: `pending → in_progress → approved/rejected → integrated`
- Each task gets an isolated git worktree (`orca/task-{id}` branch); workers never share files
- Workers are spawned as subprocesses via `internal/pty`; output streams to UI via WebSocket
- MCP server exposes 30 tools for LLM-driven autopilot mode (no human in loop)

**Naming conventions**
- Go packages are lowercase, single-word (e.g. `sprint`, `worktree`, `quality`)
- Command files in `cmd/orca/commands/` named by domain (`task.go`, `sprint.go`)
- React components: PascalCase files, co-located with their hooks
- Task runner targets: `namespace:action` (e.g. `web:build`, `build:go`)

**Error handling**
- Go: errors propagated up with `fmt.Errorf("context: %w", err)` wrapping; no panics in business logic
- Monitoring goroutines (stuck, budget, conflict) run on configurable intervals, emit structured log events
- Crash recovery: orphaned worktrees and interrupted sprints detected on startup

**State**
- SQLite via `go-sqlite3` in `internal/state/` — single DB file, no ORM
- File watchers in `internal/state/watcher.go` for real-time updates
- WebSocket bridge (`web/src/lib/wsQueryBridge.ts`) invalidates TanStack Query cache on push events

**Config**
- YAML config at `.orca/orca.yaml` in the target project (not in orca's own repo)
- Defaults in `internal/config/defaults.yaml`, merged at load time
- Per-phase overrides for cost budgets and worker counts supported

---

## Dependencies

**Go (direct)**
| Dep | Purpose |
|-----|---------|
| `spf13/cobra` | CLI framework |
| `gorilla/websocket` | WebSocket server |
| `mattn/go-sqlite3` | SQLite state store (CGO) |
| `creack/pty` | PTY for streaming worker output |
| `google/uuid` | Task/sprint ID generation |
| `gopkg.in/yaml.v3` | Config parsing |
| `charmbracelet/*` | TUI (bubbletea, bubbles, lipgloss, huh) |

**Web (key)**
| Dep | Purpose |
|-----|---------|
| `react` 19 | UI framework |
| `@tanstack/react-query` | Server state / API caching |
| `@tanstack/react-form` | Form management |
| `@xterm/xterm` | Terminal emulator in browser |
| `@dnd-kit/*` | Drag-and-drop board |
| `tailwindcss` 4 | Styling |
| `vite` 7 | Bundler |
| `biome` | Linter + formatter (replaces ESLint/Prettier) |

---

## Build & Test

```bash
# Install web deps (uses Bun)
task web:install

# Full build (web → embed → go binary → dist/orca)
task build

# Go only (assumes web already built)
task build:go

# Run all Go tests
task test           # go test ./cmd/... ./internal/...

# Go vet
task vet

# Web dev server (proxies to Go backend on :8080)
task web:dev

# Clean
task clean          # removes dist/ and web/dist/
```

**Notes:**
- `go-sqlite3` requires CGO; ensure a C compiler is available
- Web assets are embedded into the Go binary via `//go:embed` in `web/embed.go`
- No GitHub Actions present; no automated CI configured
- Single web test: `web/src/lib/logParser.test.ts` (no Vitest config visible — may need `bun test`)
- Config for a target project lives in `<target-repo>/.orca/orca.yaml`, not in this repo