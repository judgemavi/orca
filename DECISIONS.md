# Design Decision Log

Tracks key decisions and the reasoning behind them. Newest first.

---

## v0.3 — Dev Team Model (Feb 2026)

### Dropped file claims, adopted worktree isolation + merge/rebase
- **Was:** Tasks declare which files they'll touch. Overlapping claims → serialized.
- **Now:** No file claims. Each task gets a worktree. Conflicts resolved at merge time.
- **Why:** Real dev teams don't file-lock. They use branches and resolve conflicts at PR time. File claims can't predict the unpredictable (bug fixes, refactors). Worktrees give true isolation. Merge conflicts are handled by rebasing + re-running the worker.

### Switched from single-shot to multi-turn workers
- **Was:** `claude -p "prompt"` single-shot headless only.
- **Now:** Multi-turn interactive as primary, headless for simple tasks. Mode selected per task.
- **Why:** Real devs don't work single-shot. They explore, implement, test, iterate. Even `claude -p` is multi-tool (can read/write files), but complex tasks need full interactive capability. Start with headless in MVP, add interactive in Phase 2/3.

### Added typed roles (tech lead, developer, reviewer, integrator)
- **Was:** Generic "workers" — all the same.
- **Now:** Four distinct roles with different responsibilities.
- **Why:** Models how real teams work. Tech lead explores codebase before anyone codes. Developers implement. Reviewers check quality (different agent than the author). Integrator merges. Clear separation of concerns.

### Added exploration phase
- **Was:** Decomposer needs codebase knowledge but has none.
- **Now:** Explicit explore phase where tech lead agent maps the codebase. Output is cached and injected into all worker prompts.
- **Why:** You can't decompose work well without understanding the code. Real teams have a tech lead who knows the codebase. The exploration phase is that knowledge-building step.

### Added adaptive ceremony
- **Was:** Every execution goes through full sprint lifecycle.
- **Now:** 1 task → just run. 2-5 → lightweight. 5+ → full sprint.
- **Why:** Sprint overhead is wasteful for small work. Real small teams skip ceremony. Scale process to the work.

---

## v0.2 — Scrum Model (Feb 2026)

### Adopted Scrum-inspired batch execution
- **Was:** Continuous task queue with ad-hoc scheduling.
- **Now:** Plan/execute/review cycles (sprints).
- **Why:** Solves the "task tree mutates mid-execution" problem. Sprint boundaries are natural checkpoints for human approval, conflict resolution, and course correction. Prevents chaos of continuous replanning.

### User-as-supervisor by default
- **Was:** Undefined — implied LLM orchestrator.
- **Now:** User is always supervisor in manual mode. LLM autopilot is opt-in.
- **Why:** LLM coordination burns tokens on decisions humans make better. User should control the process by default. Autopilot is an optimization for experienced users who trust the system.

### Workers don't communicate with each other
- **Was:** Three communication levels including direct worker-to-worker.
- **Now:** All coordination through supervisor. Workers are dumb executors.
- **Why:** Worker-to-worker creates distributed consensus problems. If tasks are properly atomic, workers don't need to talk. The supervisor owns the task tree and is the single source of truth.

---

## v0.1 — Initial Design (Feb 2026)

### Wrap CLIs, don't call APIs
- CLI tools handle auth, context, tool use, model selection. Pod doesn't reimplement.
- Users keep their local config, custom instructions, tool setups.

### Git worktrees for isolation
- True filesystem isolation per worker.
- Native merge/rebase for integration.
- Universal diff as artifact format.

### Config-driven tool definitions
- New tools added via YAML, no code changes.
- Adapter handles binary, args, mode, timeout.

### Go as language
- Single binary, no runtime deps.
- Strong process management and concurrency.
