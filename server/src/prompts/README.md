# Prompts

Prompt templates live in `md/` as Markdown files, embedded at build time via Bun text imports.

## Files

| File | Interaction Type | `%s` placeholders (in order) |
|------|------------------|------------------------------|
| `output_style.md` | all (appended) | — |
| `executor_style.md` | run | — |
| `plan.md` | plan | memory context, title, description |
| `review.md` | review | title, description, diff, user prompt |
| `retro.md` | retro | title, description, diff, plan, review, existing memory |
| `explore.md` | explore | — (template appended, not formatted) |
| `evaluate.md` | evaluate | codebase context, title, description |
| `breakdown.md` | breakdown | goal (context prepended separately) |
| `sync_context.md` | memory-sync | current context, diff, changed files |
| `conflict_resolve.md` | merge | — |
| `orchestrator.md` | orchestrator | — |

## Override

Copy any file to `<project>/.orca/prompts/<same_name>.md`. The loader checks there first and falls back to the embedded default.
