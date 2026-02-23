# Making Orca Universal: Greenfield + Legacy Migration + Stack Migration

## Core Idea

Thread a **project mode** through Orca that gates prompt selection, validation, decomposition strategy, and sprint ordering — without restructuring the existing pipeline. Most impact comes from mode-aware prompts + validation profiles.

## 7 Changes, Ordered by Impact

### 1. Project Mode in Config
- Add `mode: greenfield | legacy_migration | stack_migration | standard` to `ProjectConfig`
- `ProjectMode()` helper defaults empty to `"standard"`
- Wire into init wizard as mode selection step
- **Files**: `internal/config/config.go`, `cmd/orca/commands/misc.go`

### 2. Mode-Aware Prompts
- `prompts.ForMode(phase, basePrompt, mode)` — appends mode-specific addendum to base prompt, noop for standard
- 9 new `.md` files (3 modes x 3 phases: explore, decompose, plan) + review addendums for migration modes
- Key content:
  - **Greenfield explore**: document desired architecture, not existing code
  - **Legacy decompose**: "migrate X from old→new" pattern, component grouping, prep→migrate→validate→cleanup ordering
  - **Stack decompose**: "replace A with B" pattern, adapter-first strategy, phased approach
- Wire mode through Explorer, Decomposer, Generator, Reviewer constructors
- **Files**: `prompts/prompts.go`, 9 new `prompts/*_<mode>.md`, + 4 internal packages + 4 CLI commands

### 3. Task Model: Category, Priority, Migration Metadata
- `Task` gets: `Category string` (scaffold/feature/migration/test/config), `Priority int`, `Metadata *TaskMetadata`
- `TaskMetadata`: `MigrationSource`, `MigrationTarget`, `ComponentName`, `MigrationPhase`
- DB migrations 9-11: three `ALTER TABLE ADD COLUMN`
- Extend `ProposedTask` in decompose — mode prompts instruct LLM to populate these
- **Files**: `internal/task/task.go`, `internal/state/state.go`, `internal/decompose/decompose.go`, CLI + MCP updates

### 4. Sprint Ordering
- Change `GetReady()` SQL from plain `ORDER BY created_at` to:
  ```sql
  ORDER BY priority DESC,
    CASE category WHEN 'scaffold' THEN 0 WHEN 'config' THEN 1
    WHEN 'migration' THEN 2 WHEN 'feature' THEN 3 ELSE 5 END,
    created_at
  ```
- Scaffold tasks run first, high-priority floats up. Zero changes to sprint planner itself.
- **File**: `internal/task/task.go`

### 5. Validation Profiles
- Add `profiles: map[string][]string` and `dual_mode: bool` to `ValidationConfig`
- Example: `profiles: {legacy: ["npm test"], new: ["go test ./..."]}` with `dual_mode: true` runs both during migration
- `ValidateWithProfiles()` on Integrator — runs base + all profiles (dual) or active profile only
- **Files**: `internal/config/config.go`, `internal/integrator/integrator.go`, `cmd/orca/commands/merge.go`

### 6. Scaffold Command (Greenfield)
- `orca scaffold "Go REST API" --template go` — runs headless LLM to generate project structure, commits, then auto-explores
- New `internal/scaffold/scaffold.go` package + `prompts/scaffold.md`
- Explore phase soft-guards: when greenfield + empty repo, suggests `orca scaffold` first
- **New files**: `internal/scaffold/scaffold.go`, `prompts/scaffold.md`, `cmd/orca/commands/scaffold.go`

### 7. Migration Tracker
- `orca migration status` — aggregates task metadata by component, shows progress table
- `ComponentStatus`: component name, source→target, phase, completed/total tasks
- No new DB tables — derived view over task metadata fields
- Exposed via MCP as `migration_status` tool
- **New files**: `internal/migration/tracker.go`, `cmd/orca/commands/migration.go`, MCP tool addition

## Backward Compat

- Mode defaults to `""` = standard = current behavior
- All new Task fields nullable/optional
- Base prompts untouched — addendums appended only for non-standard modes
- Schema: additive `ALTER TABLE` only
- Sprint ordering: existing tasks with no category/priority sort last by `created_at` (same as today)

## Execution Order

**A** (mode + config) → **B** (prompts) → **C** (task model) → **D** (sprint ordering) → **E** (validation profiles) → **F** (scaffold) → **G** (migration tracker)

Each phase is one PR, independently shippable.

## Verification

1. `orca init` — verify mode selection appears, config writes correctly
2. `orca explore` — verify mode-aware prompt is used (check with `--verbose`)
3. `orca breakdown "goal"` — verify decompose produces category/priority/metadata fields for migration modes
4. `orca task add --category scaffold --priority 1 "Setup project"` — verify task stored correctly
5. `orca sprint plan` — verify scaffold/high-priority tasks selected first
6. `orca scaffold "Go REST API"` — verify project structure created (greenfield)
7. `orca merge` — verify dual validation runs both profiles (migration modes)
8. `orca migration status` — verify component progress table renders
9. `go test ./...` — all existing tests pass
