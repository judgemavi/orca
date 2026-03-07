Analyze this codebase and produce a concise context document in markdown.

Focus on what another developer (or AI agent) needs to contribute effectively:

1. **Project overview** — what this does, in 1-2 sentences
2. **Architecture** — how the system is structured, key modules and their relationships
3. **Conventions** — naming patterns, error handling style, file organization, anything non-obvious
4. **Development tooling** — detect and document the project's dev tooling by inspecting config files, package.json scripts, Makefiles, etc:
   - **Package manager** — npm, yarn, pnpm, bun, etc.
   - **Linter** — eslint, biome, golangci-lint, etc. Include the check and fix commands.
   - **Formatter** — prettier, biome format, gofmt, etc. Include the check and fix commands.
   - **Type checker** — tsc, mypy, etc. Include the check command.
   - **Test runner** — jest, vitest, bun test, go test, pytest, etc. Include the run command.
   - **Build** — build command if applicable.
   - Note: Always include the exact commands as they appear in package.json scripts or config. If standard for the stack, still document them.

Skip:
- The `.orca/` directory (runtime orchestration state, not project code)
- Any files/directories listed in `.gitignore` (treat them as non-existent for this context)
- Directory tree listings (the filesystem is always available)
- Dependency lists (the package manager already tracks these)

Keep it under 300 lines. Prioritize insight over completeness.

Output format:
1. A short "Project Summary" section (5-10 lines max) with stack, architecture style, and key conventions. This section is extracted as a single memory entry tagged "project-summary" with source_type="explore".
2. Any additional context sections you consider high-signal.
3. A `## Memory Extraction` section (JSON array only) with discrete, self-contained entries. Each entry is stored as a memory entry tagged "explore-seed" with source_type="explore". Entries include covered_at_commit tracking and are superseded on subsequent explore runs.

## Memory Extraction

After the context document, add a section exactly titled `## Memory Extraction` and include a JSON array only:

```json
[{"content":"...","category":"architecture|dependency|pattern|convention|tooling","tags":["..."],"confidence":0.95,"file_paths":["path/to/file"]}]
```

One entry MUST have `category: "tooling"` with a structured description of detected dev commands:
```
Package manager: bun
Lint: bun run lint (biome check), fix: bun run lint --fix
Format: bun run format (biome format --write)
Typecheck: bunx tsc --noEmit
Test: bun test
Build: bun run build
```
Tag it `["dev-tooling"]`. Even if using standard tooling, always include this entry.

Rules:
- Use repo-root-relative `file_paths`.
- Exclude paths that are not tracked by git.
- Each entry must be understandable on its own without requiring other entries.
- Return `[]` when there is no durable memory to add.
