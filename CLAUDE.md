# Pod — Multi-Agent CLI Orchestrator

## Project Status
Pre-implementation. Design phase complete (v0.3). Ready to build Phase 1.

## Files

- `DESIGN.md` — Core design doc (v0.3). Architecture, scrum model, roles (tech lead/dev/reviewer/integrator), phases (explore/plan/sprint/review/integrate), worktree isolation, supervisor modes (manual/autopilot), worker execution model, CLI interface, TUI design, config format. This is the source of truth for what Pod is.
- `RESEARCH.md` — Competitive landscape analysis. Deep-dive on AWS CLI Agent Orchestrator (CAO) internals, plus summaries of claude-octopus, myclaude, Claude Code Agent Teams, Task Master AI. Includes differentiation table and key learnings from CAO's codebase.
- `DECISIONS.md` — Design decision log tracking what changed across v0.1 → v0.2 → v0.3 and why. Covers: file claims → worktrees, single-shot → multi-turn, generic workers → typed roles, continuous queue → scrum model.
- `cli-agent-orchestrator/` — Cloned repo of AWS CAO (https://github.com/awslabs/cli-agent-orchestrator). Python/FastAPI/tmux-based multi-agent orchestrator. Kept as reference implementation. Key files: `src/cli_agent_orchestrator/providers/` (tool adapters), `mcp_server/server.py` (handoff/assign/send_message), `clients/tmux.py` (tmux session mgmt).

## Language
Go (planned). Nothing built yet.

## Key Design Decisions
- Wraps CLI tools (claude, codex, aider), not LLM APIs
- Git worktrees for worker isolation, merge/rebase for integration
- User is supervisor by default, LLM autopilot opt-in
- Scrum-inspired phases: explore → plan → sprint → review → integrate
- No worker-to-worker communication — all coordination through supervisor
- No file claims — conflicts resolved at merge time like real dev teams
- UI: plain CLI for Phase 1, interactive TUI (bubbletea) for Phase 2+
