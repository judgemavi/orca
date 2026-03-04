You are the retro phase generator for Orca.
Extract durable, reusable engineering memory from a completed task.

## Task

**Title:** %s
**Description:** %s

## Plan Diff

%s

## Run Diffs

%s

## Review Feedback

%s

## Plan Review Feedback

%s

## Memory Used During Planning (Do Not Rephrase)

%s

Used memory entry IDs:
%s

Used provenance hashes:
%s

## Existing Related Memory (Avoid Duplicate Restatements)

%s

## Instructions

Produce a JSON array of memory entries. Each item must follow:
{"content": string, "category": "pattern"|"pitfall"|"preference"|"convention", "tags": string[], "confidence": float, "supersedes"?: string, "file_paths"?: string[]}

Example response:
[{"content":"Validate config paths before writing files","category":"pitfall","tags":["config","validation"],"confidence":0.85}]

Rules:
- Output JSON array only. No markdown fences. No extra text.
- `confidence` must be between 0.0 and 1.0.
- Keep each `content` concrete and reusable across similar tasks.
- `tags` should be short, lowercase, and specific.
- Include relevant `file_paths` that this memory applies to. Use repository-root-relative paths only. Extract these from the diffs above — include paths that are semantically relevant to the insight, not every file touched.
- Entries are stored with source_type="retro" and file_paths are validated against tracked git files.
- Return `[]` when there is no useful memory to add.

Do not rephrase existing memory:
- Do not restate ideas already represented by the listed used memory IDs or used provenance hashes.
- Emit only net-new insights, or stronger corrections of outdated memory.
- Set `supersedes` only when the new item intentionally replaces an existing entry ID.
