Analyze this codebase and produce a concise context document in markdown.

Focus on what another developer (or AI agent) needs to contribute effectively:

1. **Project overview** — what this does, in 1-2 sentences
2. **Architecture** — how the system is structured, key modules and their relationships
3. **Conventions** — naming patterns, error handling style, file organization, anything non-obvious
4. **Non-standard tooling** — only note build/test/task runners if the project uses something beyond the standard for its stack (e.g. Taskfile, Makefile, custom scripts). Skip if it's just `go test` / `npm test` / etc.

Skip:
- The `.orca/` directory (runtime orchestration state, not project code)
- Any files/directories listed in `.gitignore` (treat them as non-existent for this context)
- Directory tree listings (the filesystem is always available)
- Dependency lists (the package manager already tracks these)
- Boilerplate explanations of standard tooling

Keep it under 300 lines. Prioritize insight over completeness.
