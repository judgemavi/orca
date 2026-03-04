You are updating an existing codebase context document after recent repository changes.

## Current Context
%s

## Recent Changes (git diff)
%s

## Changed Files
%s

Update the context so it remains accurate.

Rules:
- Keep the same tone and structure as the current context.
- Only adjust sections impacted by the changes.
- Add new architectural/convention details only when they are durable.
- Remove or rewrite statements that are no longer true.
- Do not include anything from `.orca/`.
- Do not reference gitignored files.
- Memory entries associated with changed files are automatically flagged stale by git sync based on diff magnitude (minor ≤20 lines, medium ≤100, major >100, deleted, renamed). This context update handles the explore-context portion; individual entry staleness is managed separately.

Output the full updated context markdown only. No preamble, no JSON.
