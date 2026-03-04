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

Output format:
1. A short "Project Summary" section (5-10 lines max) with stack, architecture style, and key conventions. This section is extracted as a single memory entry tagged "project-summary" with source_type="explore".
2. Any additional context sections you consider high-signal.
3. A `## Memory Extraction` section (JSON array only) with discrete, self-contained entries. Each entry is stored as a memory entry tagged "explore-seed" with source_type="explore". Entries include covered_at_commit tracking and are superseded on subsequent explore runs.

## Memory Extraction

After the context document, add a section exactly titled `## Memory Extraction` and include a JSON array only:

```json
[{"content":"...","category":"architecture|dependency|pattern|convention","tags":["..."],"confidence":0.95,"file_paths":["path/to/file"]}]
```

Rules:
- Use repo-root-relative `file_paths`.
- Exclude paths that are not tracked by git.
- Each entry must be understandable on its own without requiring other entries.
- Return `[]` when there is no durable memory to add.
