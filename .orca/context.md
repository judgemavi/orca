Written to `CONTEXT.md` — 245 lines. Covers:

1. **Project overview** — multi-agent CLI orchestrator wrapping AI tools with scrum-inspired pipeline
2. **Directory structure** — full layout with package descriptions
3. **Key patterns** — worker adapter, worktree isolation, SQLite change detection, error handling, naming
4. **Database schema** — 8 tables with migrations v1-v8
5. **Dependencies** — Go (cobra, sqlite3, websocket, pty) + Frontend (React 19, xterm, react-query, vite)
6. **Build/test** — Taskfile commands, single binary output with embedded frontend
7. **CLI commands** — all subcommand groups
8. **Config** — full `orca.yaml` structure
9. **Key algorithms** — staleness, stuck detection, conflict prediction, scope creep, sprint planning, integration ordering
10. **MCP server** — 30+ tools, config example
11. **Frontend architecture** — React Query + WebSocket + component layout