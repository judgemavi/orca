# Build Plan

**Date:** February 2026

---

## Phase 1 — MVP (2-3 weeks)

Validates: worktree isolation, parallel execution, merge/rebase flow, sprint lifecycle.

### Scope
- Manual mode only (user is supervisor)
- Headless workers only (`claude -p`, `codex -q`)
- Single tool first (Claude Code) — add others after core works
- No exploration phase — user provides context
- No autopilot

### Deliverables

**CLI commands:**
- `pod init` — init `.pod/` dir in git repo, create `pod.yaml`, init SQLite
- `pod backlog add "task"` — add task to backlog manually
- `pod backlog` — view task tree
- `pod sprint plan` — select non-dependent tasks for sprint
- `pod sprint start` — create worktrees, spawn workers in parallel
- `pod sprint status` — check worker progress
- `pod sprint review` — collect diffs, show results
- `pod integrate` — merge task branches into integration branch, run validation

**Core modules:**
- `worktree/` — create, manage, cleanup git worktrees
- `worker/` — spawn headless CLI tools, capture output, handle timeouts
- `task/` — backlog CRUD, dependency graph, sprint batching
- `integrator/` — merge, conflict detection, validation gate
- `state/` — SQLite operations
- `config/` — YAML parsing, tool adapter config

**What to test with:**
Take a real small project. Manually decompose into 3-4 tasks. Run `pod sprint start`. See if worktrees isolate properly, diffs are captured correctly, merge works.

### Key Risk
Headless `claude -p` might not be capable enough for tasks requiring codebase exploration. If so: either inject more context into the prompt, or fast-track PTY support.

---

## Phase 2 — Multi-Tool + Exploration (2-3 weeks)

### Scope
- Exploration phase (`pod explore`)
- LLM-assisted decomposition (`pod plan "goal"`)
- Multi-tool support (add Codex, Aider adapters)
- Reviewer agent (separate tool reviews another's output)
- Adaptive ceremony (skip sprint for single tasks)
- Interactive TUI (`charmbracelet/bubbletea`)

### Key Work
- Tech lead exploration agent — prompt engineering to produce useful codebase context
- Decomposer — prompt that takes goal + exploration context → atomic task tree
- Tool routing — heuristics or config for which tool gets which task type
- Reviewer prompt — takes diff + task description → approval/rejection + feedback
- TUI — live task tree, sprint progress, worker status, inline task management

---

## Phase 3 — Autopilot (2-4 weeks)

### Scope
- LLM supervisor mode
- Auto-decomposition, auto-scheduling, auto-review loop
- Cost budget tracking (per sprint, per project)
- Escalation logic (when to ask user)
- Interactive worker support (PTY) if headless proves insufficient

### Key Risk
Autopilot quality depends on LLM decomposition + review quality. This is a prompt engineering problem more than a code problem. Need real-world testing to iterate.

---

## Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | Go | Single binary, good process mgmt, concurrency |
| State | SQLite | Embedded, zero config, persists across sessions |
| Config | YAML | Human-readable, well-supported |
| CLI framework | cobra | Standard Go CLI library |
| Worker mode (MVP) | Headless pipe | Simpler, structured output, no regex |
| Worker mode (later) | PTY via creack/pty | For tools that need interactive mode |
| Isolation | Git worktrees | True FS isolation, native merge/rebase |
| Conflict resolution | Rebase + re-run | Like a dev resolving PR conflicts |
| UI (MVP) | Plain CLI | Simple, scriptable, zero deps |
| UI (Phase 2) | TUI via bubbletea | Live dashboard, inline task mgmt |

---

## What to Build First (Day 1)

1. `pod init` — scaffold `.pod/` directory, create SQLite DB, write default `pod.yaml`
2. Worktree manager — create/list/remove worktrees programmatically
3. Worker adapter for Claude Code headless — spawn `claude -p`, capture JSON output + diff
4. Run one task in one worktree end-to-end

Everything else builds on top of this.
