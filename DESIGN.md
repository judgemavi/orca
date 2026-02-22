# Orca — Multi-Agent CLI Orchestrator

**Status:** v1.0 — Implementation Complete
**Date:** February 2026

---

## Overview

Orca coordinates multiple AI coding CLI agents (Claude Code, Codex, Aider, etc.) on shared codebases. It wraps CLI tools as workers, not APIs.

The execution model mirrors a real dev team: explore the codebase, decompose into tasks, execute in parallel on isolated worktrees, review quality, and integrate with validation gates.

---

## Goals

- Coordinate multiple CLI-based AI agents without collision
- Recursive decomposition into small, mergeable tasks
- Scrum-inspired lifecycle: explore -> plan -> sprint -> review -> integrate -> adapt
- User-first supervision, with optional autopilot
- Git worktree isolation and deterministic integration
- Single binary, config-driven orchestration

## Non-Goals

- Replacing underlying CLI tools
- Reimplementing model providers via direct API calls
- Worker-to-worker direct communication

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                             ORCA                                  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Supervisor  (User in manual | LLM in autopilot)            │  │
│  └──────┬──────────────┬────────────────┬──────────────────────┘  │
│         │              │                │                          │
│  ┌──────▼──────┐ ┌─────▼──────┐ ┌──────▼───────┐                 │
│  │ Tech Lead   │ │ Developers │ │ Reviewer     │                 │
│  │ (explore +  │ │ (implement │ │ (PR review)  │                 │
│  │  decompose) │ │  in //)    │ │              │                 │
│  └──────┬──────┘ └─────┬──────┘ └──────┬───────┘                 │
│         │              │               │                          │
│         │        ┌─────┴─────────────┐ │                          │
│         │        │  Worktree Pool    │ │                          │
│         │        └─────┬─────────────┘ │                          │
│         │              │               │                          │
│         │        ┌─────▼───────────────▼──┐                       │
│         │        │  Integrator            │                       │
│         │        │  merge -> validate     │                       │
│         │        └─────┬──────────────────┘                       │
│         │              │                                          │
│  ┌──────▼──────────────▼──────────────────────────────────────┐   │
│  │  orca/integration branch                                     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  State (SQLite)                                              │   │
│  │  backlog · sprints · artifacts · exploration context         │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

---

## Roles

### Tech Lead (Explore + Decompose)

Builds codebase understanding first, then decomposes goals into atomic tasks with dependency ordering.

### Developer (Implement)

Runs one task per isolated worktree, iterates autonomously, and produces commits on `orca/task-{id}`.

### Reviewer (PR Review)

Reviews completed task diffs against intent, correctness, and quality signals.

### Integrator (Merge + Validate)

Merges approved branches into `orca/integration`, resolves conflicts, and executes validation commands.

---

## Supervisor Modes

### Manual (Default)

User controls exploration, tasking, sprint actions, and approvals.

### Autopilot

LLM handles orchestration phases with escalation to user on ambiguity, repeated failures, or unresolved conflicts.

---

## Phases

### 1. EXPLORE

`orca explore`

Runs an exploration agent and stores context in `.orca/context.md` for prompt injection in later phases.

### 2. PLAN

`orca plan "goal description"`

Creates dependency-aware tasks. Tasks are intentionally small to reduce merge friction.

### 3. SPRINT

`orca sprint start`

Executes ready tasks in parallel:
1. Create worktree from `orca/integration`
2. Inject task prompt + exploration context
3. Run worker
4. Capture diff/output/artifacts

### 4. REVIEW

`orca sprint review`

Completed task artifacts are reviewed before integration. Review surfaces diff plus quality payload (scope flags and test delta signals) from stored artifacts.

### Quality Gates

Quality gates run during sprint execution and are attached to task artifacts:

- Scope creep analysis (`internal/quality/scope.go`): flags high file count, high line churn, wide directory spread, and low/no test additions for multi-file changes.
- Test delta (`internal/quality/testdelta.go`): compares before/after validation snapshots and detects new failures/regressions.
- Diff-vs-task alignment (`internal/review/alignment.go`): optional LLM-based check for intent alignment. Implemented and available as a reviewer capability; intended for selective use due to token cost.

Quality results are stored in `artifacts.quality_json` and returned in review APIs/tools.

### 5. INTEGRATE

`orca integrate`

Approved tasks are merged and validated with active gates (not just configured):

1. Smart merge ordering: tasks are sorted by smallest diff first (`internal/integrator/integrator.go`) to reduce conflict surface.
2. Merge each task into `orca/integration`.
3. On conflict, attempt rebase and optional tool-assisted conflict resolution.
4. Run validation commands.
5. If validation fails, revert merge commit and keep integration clean.

### 6. ADAPT

Update backlog and sprint state:
- merged tasks leave backlog
- failed tasks return with failure context
- newly discovered work is added to backlog

---

## Worker Execution Model

Workers execute either:
- Interactive multi-turn mode in a PTY/worktree
- Headless mode for bounded tasks

Each worker gets exploration context and task prompt. Completion is process-based; artifacts are persisted for review/integration.

---

## Sprint Health Monitoring

Three runtime monitors run as background goroutines during sprint execution (`internal/sprint/executor.go`):

- Stuck detection (`internal/monitor/stuck.go`): detects no-progress loops (unchanged diff hash across cycles) and edit-revert cycles (repeated prior diff hashes).
- Budget enforcement (`internal/monitor/budget.go`): tracks per-task and per-sprint spend; on breach, emits alert and interrupts the task process.
- Live conflict prediction (`internal/monitor/conflict.go`): scans active worktrees for overlapping changed files and emits early conflict alerts.

Why: fail faster on stalled work, runaway spend, and avoidable merge collisions.

---

## Crash Recovery

Sprint/task recovery primitives live in `internal/sprint/sprint.go`:

- `RecoverOrphans`: finds tasks still marked `running` after interruption.
- `ResolveOrphan`:
1. task has commits beyond integration -> move to `review`
2. no commits -> move to `failed`
- `RecoverSprint`: marks interrupted running sprint as `failed`.

Operator flow includes `orca sprint resume` to recover interrupted execution and continue safely.

---

## Exploration Staleness

Exploration freshness is tracked by file-tree hash (`internal/explore/explore.go`):

- After explore/manual context write, Orca stores `.orca/context.hash` alongside `.orca/context.md`.
- Hash is computed from `git ls-files` output.
- `IsStale()` compares current tree hash to stored hash.
- Status endpoints/tools expose staleness for pre-sprint warnings.
- `orca explore --check` supports scriptable staleness checks.

Why: avoid executing sprints on outdated codebase context.

---

## Worktree Management

Each task runs in its own `task-{id}` worktree and branch (`orca/task-{id}`).

Lifecycle:
1. create worktree from integration
2. execute worker and capture artifacts
3. merge approved task
4. remove worktree on successful integration

Cleanup features (`internal/worktree/worktree.go`):
- TTL-based stale worktree cleanup
- `orca cleanup` and `orca cleanup --dry-run`
- Disk usage tracking across worktrees

---

## Communication Model

Workers never communicate directly.

- Supervisor -> worker: task prompt + exploration context
- Worker -> supervisor: process exit + artifacts
- Inter-task dependencies: handled by phase ordering and sprint planning

---

## CLI Interface

```bash
# Setup
orca init
orca config

# Explore
orca explore
orca explore --manual
orca explore --check              # Check context staleness

# Plan / Backlog
orca plan "goal description"
orca plan --manual
orca backlog
orca backlog add "task"
orca backlog edit task-001

# Sprint
orca sprint plan
orca sprint start
orca sprint status
orca sprint review
orca sprint resume                # Recover interrupted sprint
orca sprint cancel

# Integration
orca integrate
orca integrate --dry-run

# Worktrees
orca cleanup                      # Remove stale worktrees
orca cleanup --dry-run            # Preview cleanup

# General
orca status
orca log
```

---

## MCP Interface

Orca exposes 19 MCP tools (`internal/mcp/tools.go`) for orchestrator agents.

### Task
- `task_list`
- `task_create`
- `task_update`
- `task_approve`
- `task_request_changes`

### Sprint
- `sprint_plan`
- `sprint_start`
- `sprint_status`
- `sprint_cancel`
- `sprint_reset`

### Review / Quality
- `review_get`
- `review_sprint`
- `quality_results`

### Explore
- `explore`
- `explore_status`

### Monitor / Budget
- `budget_status`

### Worktree
- `worktree_cleanup`
- `worktree_status`

### Integration
- `integrate`

---

## Web Interface

Orca ships a web UI (React + Vite) served by the API server under `/ui/`.

Key capabilities:
- Board view with task columns by status (backlog -> merged/failed)
- Real-time updates via WebSocket (`/api/v1/ws`) for tasks, sprints, sessions, operations, monitor alerts
- Console panel for live orchestration output/events
- Terminal sessions over WebSocket (`/api/v1/terminal/{session_id}`)
- Session APIs for worker/orchestrator lifecycle visibility

Core API route groups (`internal/api/server.go`):
- tasks, sprints, review, plan, explore, integrate
- config, status, costs, cleanup, monitor alerts
- websocket + terminal streaming

---

## Configuration

`orca.yaml` includes orchestration, monitor, quality, and cleanup controls:

```yaml
project:
  name: my-project
  integration_branch: orca/integration
  worktree_dir: .orca/worktrees

tools:
  claude:
    binary: claude
    interactive_args: ["--append-system-prompt", "{{context}}"]
    headless_args: ["-p", "{{prompt}}", "--output-format", "json"]
    timeout: 600s
  codex:
    binary: codex
    headless_args: ["exec", "{{prompt}}", "--full-auto"]
    timeout: 600s

validation:
  commands:
    - "go test ./..."
    - "go vet ./..."

workers:
  max_parallel: 3

orchestrator:
  cost_budget: 5.0
  supervisor_tool: claude

monitor:
  stuck_check_interval: 30s
  max_stuck_cycles: 3
  conflict_check_interval: 15s
  task_budget: 0

quality:
  enabled: true
  scope_check: true
  test_delta: true
  alignment_check: false

cleanup:
  ttl: 168h
```

---

## Persistence

SQLite (`.orca/state.db`) stores:
- tasks and dependencies
- sprints and phase state
- artifacts (diff/stdout/stderr/quality payload)
- costs
- operations and sessions
- exploration context metadata

---

## Open Questions

- Alignment gate wiring: should `alignment_check` run automatically for every reviewed task, or only on flagged/high-risk diffs?
- Monitor config parity: should executor consume all `monitor.*` settings directly (intervals, per-task budgets) instead of fixed runtime defaults?
- Recovery UX: should startup auto-apply orphan resolution, or require explicit `orca sprint resume` confirmation in all modes?
