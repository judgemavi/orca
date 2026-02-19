# Pod — End-to-End Test Guide

## Prerequisites

- Go installed
- `claude` CLI installed and authenticated
- `codex` CLI installed and authenticated (optional — can use claude-only)
- Git configured

## Setup

### 1. Build Pod

```bash
cd ~/projects/openorc
go build -o pod ./cmd/pod/
export POD=~/projects/openorc/pod
```

### 2. Create test repo

```bash
rm -rf /tmp/pod-test /tmp/pod/worktrees
mkdir /tmp/pod-test && cd /tmp/pod-test

git init
go mod init github.com/test/greet

cat > greet.go << 'EOF'
package greet

// Greet returns a greeting for the given name.
func Greet(name string) string {
	return "Hello, " + name + "!"
}
EOF

cat > greet_test.go << 'EOF'
package greet

import "testing"

func TestGreet(t *testing.T) {
	got := Greet("World")
	want := "Hello, World!"
	if got != want {
		t.Errorf("Greet() = %q, want %q", got, want)
	}
}
EOF

go test ./...
git add -A && git commit -m "initial: greet package with test"
```

### 3. Initialize Pod

```bash
$POD init
```

Expected output:
```
Initialized Pod in /tmp/pod-test
```

This creates `.pod/` with `pod.yaml` (config) and `state.db` (SQLite), plus a `pod/integration` branch.

### 4. Check config

```bash
$POD config show
```

You should see tools (claude, codex, aider), workers.max_parallel=3, autopilot defaults.

---

## Part 1: Manual Sprint Workflow

### 5. Add tasks to backlog

```bash
# Task 1: Claude adds a Farewell function
$POD backlog add "Add Farewell function" \
  --description "Create farewell.go in the greet package with a Farewell(name string) string function that returns 'Goodbye, <name>!'" \
  --tool claude

# Task 2: Codex adds a TimeGreet function
$POD backlog add "Add TimeGreet function" \
  --description "Create timegreet.go in the greet package with a TimeGreet(name string, hour int) string function. If hour < 12 return 'Good morning, <name>!', if hour < 18 return 'Good afternoon, <name>!', otherwise 'Good evening, <name>!'" \
  --tool codex
```

Each prints a short ID like `Created task a1b2c3d4: Add Farewell function`.

### 6. Check the backlog

```bash
$POD backlog list
```

Expected:
```
○ a1b2c3d4  Add Farewell function      tool: claude
○ e5f6g7h8  Add TimeGreet function      tool: codex
```

### 7. Add a dependent task (using short IDs)

Replace `<ID1>` and `<ID2>` with the 8-char IDs from step 6:

```bash
$POD backlog add "Add tests for Farewell and TimeGreet" \
  --description "Add tests to greet_test.go for Farewell and TimeGreet. Test Farewell('World') => 'Goodbye, World!'. Test TimeGreet('Alice',9) => 'Good morning, Alice!', TimeGreet('Bob',14) => 'Good afternoon, Bob!', TimeGreet('Charlie',20) => 'Good evening, Charlie!'." \
  --tool claude \
  --depends-on <ID1>,<ID2>
```

### 8. Edit a task (short ID prefix)

```bash
$POD backlog edit <ID1> --prompt "Create farewell.go with func Farewell(name string) string that returns 'Goodbye, <name>!'. Keep it simple, one function, one file."
```

### 9. Check project status

```bash
$POD status
```

Shows task counts by status and active sprint info.

### 10. Plan sprint 1

```bash
$POD sprint plan
```

Should pick tasks 1 + 2 (no deps blocking them). Task 3 stays blocked.

```
Sprint xxxxxxxx planned (2 tasks)

  ○ a1b2c3d4  Add Farewell function
  ○ e5f6g7h8  Add TimeGreet function
```

### 11. Execute sprint 1

```bash
$POD sprint start
```

This runs both workers in parallel in separate git worktrees. Each worker:
- Gets its own worktree branched from `pod/integration`
- Runs its assigned tool headlessly (claude -p / codex exec)
- Commits changes in the worktree
- Captures diff, stdout, stderr, exit code, duration

Wait for it to finish. Expected output:
```
Starting sprint xxxxxxxx...

  ✓ a1b2c3d4  Add Farewell function  (45s)
  ✓ e5f6g7h8  Add TimeGreet function  (30s)

Sprint complete: 2 succeeded, 0 failed
```

### 12. Review sprint 1

```bash
# Summary view
$POD sprint review

# Full diffs
$POD sprint review --verbose
```

### 13. Integrate sprint 1

```bash
$POD integrate
```

Merges task branches into `pod/integration`:
```
  ✓ Merged task-a1b2c3d4
  ✓ Merged task-e5f6g7h8

Integrated: 2 merged, 0 failed
```

Verify:
```bash
git checkout pod/integration
ls *.go          # should have farewell.go, timegreet.go
go test ./...    # should pass
git checkout main
```

### 14. Sprint 2 — dependent task

```bash
$POD sprint plan    # picks task 3 (deps now satisfied)
$POD sprint start
$POD sprint review --verbose
$POD integrate
```

### 15. Verify final state

```bash
git checkout pod/integration
go test ./...       # all tests should pass
git log --oneline   # merge commits for all 3 tasks
git checkout main
```

### 16. Check sprint history

```bash
$POD log
```

Shows last 10 sprints with task counts. Use `--all` for full history.

### 17. Check costs

```bash
$POD costs
```

Shows per-tool token usage and estimated costs (only works with claude tool which outputs JSON with cost data).

---

## Part 2: Sprint Recovery

### 18. Test sprint reset

Add a new task, plan, start, then kill it mid-run:

```bash
$POD backlog add "Add a Shout function" \
  --description "Create shout.go with func Shout(s string) string that returns strings.ToUpper(s)+'!!!'" \
  --tool claude

$POD sprint plan
$POD sprint start   # hit Ctrl+C while running
```

Then recover:
```bash
$POD sprint reset
```

Expected:
```
Sprint xxxxxxxx reset. Tasks reverted to pending.
```

Verify tasks are back to pending:
```bash
$POD backlog list
```

### 19. Test sprint cancel (from another terminal)

In terminal 1:
```bash
$POD sprint plan && $POD sprint start
```

In terminal 2:
```bash
cd /tmp/pod-test
$POD sprint cancel
```

This sends SIGTERM to the running sprint process.

---

## Part 3: Shortcuts

### 20. Test `pod run` (all-in-one)

Make sure the task from step 18 is still pending:

```bash
$POD run
```

Does plan + start + review + integrate in one shot. All completed tasks get auto-merged.

Use `--no-integrate` to skip the merge step.

---

## Part 4: LLM-Powered Features

### 21. Explore codebase

Generate context that gets prepended to all worker prompts:

```bash
# Option A: LLM explores your codebase
$POD explore --tool claude

# Option B: Manual context from a file
$POD explore --manual path/to/context.md

# Option C: Pipe context from stdin
echo "This is a Go greeting library" | $POD explore --stdin
```

Check the output:
```bash
cat .pod/context.md
```

### 22. LLM task decomposition

```bash
$POD plan "Add Spanish greeting support with a SpanishGreet function and tests" --tool claude
```

Shows proposed tasks and asks for confirmation:
```
Proposed 2 tasks:

  1. Add SpanishGreet function  [tool: claude]
     Create spanishgreet.go with SpanishGreet(name) returning 'Hola, <name>!'
  2. Add tests for SpanishGreet  [depends on #1]  [tool: claude]
     ...

Create these tasks? [y/N]
```

Use `--auto` to skip confirmation.

After confirming, run them:
```bash
$POD run
```

---

## Part 5: Autopilot

### 23. Full autonomous loop

Autopilot does everything: explore -> decompose goal -> sprint cycles -> review -> integrate.

```bash
$POD autopilot "Add a Whisper function that lowercases and adds '...' suffix, with tests" \
  --max-sprints 2
```

This will:
1. Explore the codebase (generate context)
2. Decompose the goal into tasks
3. Ask you to confirm the plan
4. Run sprint(s) until all tasks complete
5. Review results
6. Integrate into pod/integration

Flags:
- `--max-sprints N` — limit sprint count
- `--pause-review` — pause after each review (default: true)
- `--unattended` — no pauses, fully autonomous

### 24. Set a cost budget

```bash
$POD config set autopilot.cost_budget 5.00
$POD autopilot "Add greeting in French" --unattended
```

Autopilot stops if cost exceeds budget.

---

## Part 6: Config Management

```bash
# View full config
$POD config show

# Change settings
$POD config set workers.max_parallel 5
$POD config set autopilot.enabled true
$POD config set autopilot.max_sprints 20
$POD config set autopilot.escalate_after_retries 3
```

---

## Part 7: Cleanup

```bash
# Remove stale worktrees (completed/failed task worktrees)
$POD cleanup              # removes them
$POD cleanup --dry-run    # just lists what would be removed
```

---

## Part 8: TUI (Interactive Terminal UI)

```bash
$POD tui
```

Dual-panel interface showing backlog and sprint status. Keyboard-driven.

---

## What This Validates

| # | Capability | How |
|---|---|---|
| 1 | `pod init` | Creates .pod/, config, DB, integration branch |
| 2 | `backlog add --tool` | Task assigned to specific tool |
| 3 | Short ID prefix | Edit/depends-on use 8-char prefixes |
| 4 | `backlog edit` | Modify task fields by short ID |
| 5 | `sprint plan` | Selects ready tasks respecting deps + max_parallel |
| 6 | `sprint start` | Parallel headless execution in worktrees |
| 7 | `sprint review` | Shows diffs, files changed, duration |
| 8 | `integrate` | Merges task branches into pod/integration |
| 9 | Dependency resolution | Blocked task waits until deps complete |
| 10 | Multi-tool | Claude + Codex in same sprint |
| 11 | `sprint reset` | Recovers from killed/failed sprint |
| 12 | `sprint cancel` | Sends SIGTERM from another terminal |
| 13 | `pod run` | All-in-one shortcut |
| 14 | `pod explore` | Generates .pod/context.md (LLM or manual) |
| 15 | `pod plan` | LLM decomposes goal into tasks |
| 16 | `pod autopilot` | Full autonomous loop |
| 17 | `pod costs` | Token/cost tracking |
| 18 | `pod config` | Show/set config values |
| 19 | `pod log` | Sprint history |
| 20 | `pod status` | Project overview |
| 21 | `pod cleanup` | Remove stale worktrees |
| 22 | `pod tui` | Interactive terminal UI |
| 23 | Cost budget | Autopilot respects budget limit |

## Troubleshooting

- **"Pod not initialized"** — run `pod init` in a git repo
- **sprint start hangs** — check `claude -p "say hello" --output-format json` works manually
- **codex fails** — verify `codex exec "say hello" --full-auto` works
- **"sprint already active"** — run `$POD sprint reset`
- **"no ready tasks"** — tasks stuck in running/in_sprint from crashed sprint. Fix: `$POD backlog edit <id> --status pending`
- **integrate conflict** — tasks creating separate files shouldn't conflict. If they do, check `$POD sprint review --verbose`
- **cost data empty** — only claude tool outputs JSON with cost info. Codex/aider won't have cost data.

## Full Cleanup

```bash
rm -rf /tmp/pod-test /tmp/pod/worktrees
```
