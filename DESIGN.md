# Pod — Multi-Agent CLI Orchestrator

**Status:** Draft v0.3
**Date:** February 2026

---

## Overview

Pod coordinates multiple AI coding CLI agents (Claude Code, Codex, Aider, etc.) on shared codebases. It wraps CLI tools as workers, not APIs.

The execution model mirrors how real dev teams work: a tech lead explores the codebase and decomposes work, developers implement in parallel on isolated worktrees, reviewers check quality, and an integrator merges and validates. The user supervises by default. An LLM autopilot can take over.

---

## Goals

- Coordinate multiple CLI-based AI agents without collision
- Recursive decomposition — always break work into the smallest useful units
- Scrum-inspired phases: explore → plan → execute → review → integrate
- User-first supervision, LLM autopilot opt-in
- Git worktrees for isolation, merge/rebase for integration
- Single binary, config-driven, no runtime dependencies

## Non-Goals

- Replacing underlying CLI tools
- Direct LLM API integration
- Worker-to-worker communication
- Time-boxed sprints

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                              POD                                  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Supervisor  (User in manual │ LLM in autopilot)            │  │
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
│         │        │                   │ │                          │
│         │        │  pod/task-001/ ─┐ │ │                          │
│         │        │  pod/task-002/ ─┤ │ │                          │
│         │        │  pod/task-003/ ─┘ │ │                          │
│         │        └─────┬─────────────┘ │                          │
│         │              │               │                          │
│         │        ┌─────▼───────────────▼──┐                       │
│         │        │  Integrator            │                       │
│         │        │  merge → validate → CI │                       │
│         │        └─────┬──────────────────┘                       │
│         │              │                                          │
│  ┌──────▼──────────────▼──────────────────────────────────────┐   │
│  │  pod/integration branch                                     │   │
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

Pod models a dev team, not a generic task queue. Four distinct roles:

### Tech Lead (Explore + Decompose)

An agent (or the user) that understands the codebase before any work begins.

**Explore phase:** Reads the codebase — file structure, patterns, dependencies, conventions. Produces an exploration context document that gets injected into all subsequent worker prompts.

**Decompose phase:** Breaks the goal into atomic tasks with dependency ordering. Doesn't predict file claims — just scopes work small enough that conflicts are unlikely and resolvable.

In manual mode, the user is the tech lead. In autopilot, an LLM agent runs in its own worktree (read-only) to explore and decompose.

### Developer (Implement)

Works autonomously on a single task in an isolated worktree. Multi-turn — can read code, run tests, iterate. Produces commits on a task branch.

Developers are the CLI tools: Claude Code, Codex, Aider, etc. Each gets a task prompt enriched with exploration context from the tech lead.

### Reviewer (PR Review)

Receives a diff + task description. Checks correctness, style, test coverage. Approves or sends back with feedback. A different agent (or tool) than the one that wrote the code.

### Integrator (Merge + Validate)

Automated, not agent-driven:

1. Merge approved task branches into `pod/integration` sequentially
2. If conflict: rebase the conflicting task branch onto updated integration, re-run developer
3. Run validation gate (tests, lint, build)
4. If validation fails: task goes back to backlog with failure context

---

## Supervisor Modes

### Manual (Default)

User acts as tech lead + scrum master:

- Explores codebase themselves (or asks Pod to run exploration)
- Writes/approves task decomposition
- Assigns tools to tasks or lets Pod auto-route
- Reviews sprint results
- Intervenes mid-sprint if needed

No LLM tokens spent on coordination.

### Autopilot

LLM takes the supervisor seat:

- Runs tech lead agent for exploration and decomposition
- Plans sprints, assigns workers
- Reviews output via reviewer agent
- Handles failures (retry, re-decompose, escalate)

User can toggle at any phase boundary. Autopilot pauses at sprint review for approval unless running unattended.

**Escalation:** Ambiguity, repeated failures, or merge conflicts the LLM can't resolve → pause and ask user.

---

## Phases

Real dev teams don't jump straight to coding. Neither does Pod.

### 1. EXPLORE

Tech lead agent maps the codebase:

```
pod explore
```

Produces exploration context:
- File tree with purpose annotations
- Key patterns (routing, models, tests, config)
- Dependency map (what imports what)
- Conventions (naming, structure, test patterns)

This context gets stored and injected into every worker's prompt. Expensive but done once per project (refreshed when codebase changes significantly).

In manual mode, the user can skip this or provide their own context.

### 2. PLAN

Decompose the goal into a task tree:

```
pod plan "Add user authentication with JWT"
```

```
Epic: Add user authentication with JWT
├── task-001: Create User model and DB migration
│   depends_on: []
├── task-002: Implement password hashing utility
│   depends_on: []
├── task-003: Add login/register HTTP handlers
│   depends_on: [001, 002]
├── task-004: Add auth middleware
│   depends_on: [002]
├── task-005: Write tests for auth flow
│   depends_on: [003, 004]
└── task-006: Update router to wire auth routes
    depends_on: [003, 004]
```

No file claims. Tasks are scoped small enough that overlap is unlikely. When it happens, the integrator handles it (like a real team resolving PR conflicts).

User approves the plan (or autopilot commits it).

### 3. SPRINT

Select a batch of non-dependent tasks and execute in parallel:

```
pod sprint start
```

Sprint N picks: task-001, task-002 (no dependencies, can run in parallel)

For each task:
1. Create worktree branched from `pod/integration`
2. Drop exploration context + task-specific CLAUDE.md into worktree
3. Spawn worker (multi-turn, interactive in worktree)
4. Monitor: completion, failure, timeout
5. Capture result (commits on task branch + stdout)

Workers run autonomously. Supervisor monitors via status checks (standup).

**Standup:** Periodic status poll. If a worker finishes early, the supervisor can pull the next task from backlog. If a worker is stuck (timeout), kill and requeue.

**Adaptive ceremony:**
- 1 task → just run it, no sprint overhead
- 2-5 tasks → lightweight: plan, execute, review
- 5+ tasks → full sprint with standup checkpoints

### 4. REVIEW

Each completed task gets a PR review:

```
pod sprint review
```

For each completed task:
1. Generate diff (worktree vs integration branch)
2. Reviewer agent (or user) checks the diff
3. Approved → merge queue
4. Rejected → back to backlog with reviewer feedback attached

### 5. INTEGRATE

Merge approved work:

1. Merge task branches into `pod/integration` sequentially (dependency order)
2. On conflict: rebase conflicting task branch onto updated integration
   - Re-run the developer worker with rebase context ("these files conflicted, resolve")
   - Or: ask user to resolve manually
3. Run validation gate: tests, lint, build (configured in `pod.yaml`)
4. All green → sprint complete
5. Failures → back to backlog

### 6. ADAPT

Update state and prepare for next sprint:

- Completed tasks removed from backlog
- Failed tasks re-enter backlog with failure context
- New tasks discovered during execution added to backlog
- Autopilot: LLM evaluates what went wrong, adjusts decomposition strategy
- → next sprint

---

## Worker Execution Model

### Multi-Turn Interactive (Primary)

Workers run CLI tools interactively in their worktree. This gives agents full capability: read files, run commands, use tools, iterate.

```
# Pod creates worktree, drops context files, then:
cd /tmp/pod/worktrees/task-001/
claude --append-system-prompt "$(cat .pod/context.md)"
# Agent works autonomously within the worktree
```

Status detection via process exit. When the agent completes, Pod captures the worktree state (git diff).

For tools like Claude Code: use `claude` in interactive mode with `--append-system-prompt` for context injection. Agent works, exits with `/exit` when done, or Pod sends interrupt after timeout.

For headless-capable tools: `claude -p "prompt" --output-format json` for simpler tasks where single-shot suffices.

### Mode Selection Per Task

```yaml
tools:
  claude:
    binary: claude
    interactive_args: ["--append-system-prompt", "{{context}}"]
    headless_args: ["-p", "{{prompt}}", "--output-format", "json"]
    timeout: 600s

  codex:
    binary: codex
    interactive_args: []
    headless_args: ["-q", "{{prompt}}", "--approval-mode", "full-auto"]
    timeout: 300s

  aider:
    binary: aider
    interactive_args: ["--yes-always", "--no-auto-commits"]
    headless_args: ["--message", "{{prompt}}", "--yes-always", "--no-auto-commits"]
    timeout: 600s
```

Scheduler picks mode based on task complexity. Simple creation tasks → headless. Tasks requiring exploration/iteration → interactive.

---

## Worktree Management

```
repo/
├── .git/
├── .pod/
│   ├── pod.yaml          # Project config
│   ├── state.db          # SQLite
│   └── context.md        # Exploration output
├── (main working tree)
│
└── (external worktrees, managed by Pod)
    /tmp/pod/worktrees/
    ├── integration/      # pod/integration branch checkout
    ├── task-001/         # branched from pod/integration
    ├── task-002/         # branched from pod/integration
    └── task-003/         # branched from pod/integration
```

Each worktree gets:
- Its own branch: `pod/task-{id}`
- A `.pod/` directory with task prompt and exploration context
- Full filesystem isolation from other workers

Worktree lifecycle:
1. Created at sprint start: `git worktree add /tmp/pod/worktrees/task-001 -b pod/task-001 pod/integration`
2. Context files injected
3. Worker runs inside the worktree
4. On completion: diff captured, branch ready for merge
5. On successful merge: worktree removed (`git worktree remove`)
6. On failure: worktree preserved for debugging

---

## Communication Model

Workers never communicate with each other. All coordination flows through the supervisor.

- **Supervisor → Worker:** Task prompt + exploration context. Injected at worktree setup.
- **Worker → Supervisor:** Completion signal (process exit) + artifacts (commits in worktree).
- **Between sprints:** Supervisor passes prior sprint output into next sprint's worker prompts as needed.
- **Worker ↔ Worker:** Not supported. Dependencies are handled by sprint ordering.

---

## Orchestration Patterns

Compose naturally within the phase model:

**Fan-out** — Single sprint, multiple workers on independent tasks. The default.

**Pipeline** — Sequential sprints. Sprint 1: tech lead explores. Sprint 2: developers implement. Sprint 3: reviewers check. Each feeds the next.

**Specialist routing** — Scheduler assigns based on tool strengths. Claude Code for refactoring, Codex for greenfield, Aider for surgical edits.

**Adversarial review** — Developer agent writes code in sprint N. Different agent reviews in sprint N+1. Feedback loop until review passes.

---

## Key Design Decisions

**Dev team model, not task queue** — Typed roles (tech lead, developer, reviewer, integrator) mirror how real teams work. Each role has clear responsibilities and handoff points.

**Explore before plan** — Codebase understanding comes before decomposition. Prevents hallucinated file paths and missed dependencies.

**Worktrees as isolation** — Each worker gets a full filesystem. Agents can read, write, run tests without affecting each other. Merge conflicts resolved at integration, not prevented at planning. Same as real teams using feature branches.

**No file claims** — Replaced by worktree isolation + merge-time conflict resolution. Tasks don't need to predict which files they'll touch. The integrator handles conflicts like a dev resolving a PR rebase.

**Multi-turn workers** — Agents run interactively, not single-shot. Real devs explore, implement, test, iterate. Agents need the same capability.

**User-first, autopilot-optional** — Manual mode burns zero coordination tokens. Autopilot is an upgrade, not the default.

**Adaptive ceremony** — Single task skips sprint overhead. 5+ tasks get full sprint model. Process scales to the work.

**Wrap CLIs, don't call APIs** — CLI tools handle auth, context, tool use, model selection. Pod orchestrates, not reimplements.

---

## CLI Interface

```bash
# Setup
pod init                          # Init Pod in current git repo
pod config                        # Edit pod.yaml

# Explore
pod explore                       # Run tech lead exploration
pod explore --manual              # User provides context

# Plan
pod plan "goal description"       # Decompose into tasks (LLM-assisted)
pod plan --manual                 # User writes task tree
pod backlog                       # View task tree
pod backlog add "task"            # Add task manually
pod backlog edit task-001         # Edit task

# Sprint
pod sprint plan                   # Select next batch
pod sprint start                  # Execute current batch
pod sprint status                 # Standup — check all workers
pod sprint review                 # Review completed work
pod sprint cancel                 # Kill in-flight workers

# Integration
pod integrate                     # Merge approved tasks
pod integrate --dry-run           # Preview merges

# General
pod status                        # Overall project status
pod log                           # Sprint history
pod cleanup                       # Remove stale worktrees
```

---

## User Interface

### Phase 1: Plain CLI

Standard command-line output. `pod backlog` prints the task tree, `pod sprint status` prints worker state, exit. User runs commands repeatedly to check progress. Simple, scriptable, zero dependencies.

### Phase 2+: Interactive TUI

Persistent terminal UI built with `charmbracelet/bubbletea`. Real-time view of backlog, sprint progress, and worker status in a single screen.

```
┌─ Backlog ──────────────────────┬─ Sprint 2 ────────────────────────┐
│                                │                                    │
│ ○ task-005 Write auth tests    │ ● task-003 Add HTTP handlers       │
│   blocked by: 003, 004        │   worker: claude  ██████░░ running  │
│ ○ task-006 Wire auth routes    │ ● task-004 Add auth middleware     │
│   blocked by: 003, 004        │   worker: codex   █████████ done ✓  │
│                                │                                    │
├─ Completed ────────────────────┤                                    │
│ ✓ task-001 Create User model   │                                    │
│ ✓ task-002 Password hashing    │                                    │
└────────────────────────────────┴────────────────────────────────────┘
 [a]dd task  [p]lan sprint  [s]tart  [r]eview  [i]ntegrate  [q]uit
```

The TUI enables:
- Live worker progress monitoring (no repeated `pod sprint status`)
- Inline task management (add, edit, reorder, assign from one screen)
- Sprint review with diff preview
- Approve/reject tasks without leaving the interface
- Worker log tailing (select a worker, see its stdout live)

The data model is identical — TUI is a rendering layer on top of the same SQLite state and CLI commands. Both interfaces remain available; TUI is the default when running interactively, plain CLI for scripts and piping.

**Library:** `charmbracelet/bubbletea` (Go TUI framework, same team behind `lazygit`-style tools like `glow`, `soft-serve`).

---

## Configuration

```yaml
# pod.yaml
project:
  name: my-project
  integration_branch: pod/integration
  worktree_dir: /tmp/pod/worktrees

tools:
  claude:
    binary: claude
    interactive_args: ["--append-system-prompt", "{{context}}"]
    headless_args: ["-p", "{{prompt}}", "--output-format", "json"]
    timeout: 600s
  codex:
    binary: codex
    headless_args: ["-q", "{{prompt}}", "--approval-mode", "full-auto"]
    timeout: 300s

validation:
  commands:
    - "go test ./..."
    - "go vet ./..."
    - "golangci-lint run"

workers:
  max_parallel: 3

autopilot:
  enabled: false
  cost_budget: 5.00          # Max $ per sprint
  escalate_after_retries: 2  # Ask user after N failures
```

---

## Language Choice

Go:

- Single binary, no runtime deps
- Strong process lifecycle mgmt (`os/exec`, signals, pipes)
- Good concurrency for parallel workers
- `creack/pty` for interactive mode
- Anthropic + OpenAI ship Go SDKs

---

## Persistence

SQLite (`.pod/state.db`):

- **tasks** — full task tree with status, deps, parent, sprint assignment
- **sprints** — sprint log with task batches and outcomes
- **artifacts** — diffs, stdout, metadata per execution
- **exploration** — cached codebase context

Persists across sessions. Resume partial projects.

---

## Open Questions

- How should the tech lead exploration agent work concretely — what prompt, what output format, how much of the codebase does it read?
- What's the right heuristic for scheduler mode selection (headless vs interactive per task)?
- How does the reviewer agent work — full diff review or targeted checks?
- Should autopilot's cost budget be per-sprint or per-project?
- How to handle tasks that spawn new tasks mid-execution (agent discovers more work needed)?
- What's the right interface for the user to intervene mid-sprint in manual mode?
