package cost

import (
	"math"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/pod/internal/state"
)

type costFixture struct {
	db      *state.DB
	tracker *Tracker
}

func setupCostFixture(t *testing.T) *costFixture {
	t.Helper()

	db, err := state.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	return &costFixture{
		db:      db,
		tracker: NewTracker(db),
	}
}

func (f *costFixture) seedSprintTask(t *testing.T) (string, string) {
	t.Helper()

	sprintID := uuid.New().String()
	taskID := uuid.New().String()

	if _, err := f.db.Exec(`INSERT INTO sprints (id, status) VALUES (?, 'completed')`, sprintID); err != nil {
		t.Fatalf("insert sprint: %v", err)
	}
	if _, err := f.db.Exec(`INSERT INTO tasks (id, title, status) VALUES (?, ?, 'completed')`, taskID, "Task"); err != nil {
		t.Fatalf("insert task: %v", err)
	}

	return sprintID, taskID
}

func floatEqual(a, b float64) bool {
	return math.Abs(a-b) < 1e-9
}

func TestRecord(t *testing.T) {
	f := setupCostFixture(t)
	sprintID, taskID := f.seedSprintTask(t)

	err := f.tracker.Record(sprintID, taskID, "claude", 120, 45, 0.42)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}

	var sprintGot, taskGot, tool string
	var inGot, outGot int64
	var costGot float64
	err = f.db.QueryRow(
		`SELECT sprint_id, task_id, tool, input_tokens, output_tokens, estimated_cost FROM costs`,
	).Scan(&sprintGot, &taskGot, &tool, &inGot, &outGot, &costGot)
	if err != nil {
		t.Fatalf("query cost row: %v", err)
	}

	if sprintGot != sprintID || taskGot != taskID || tool != "claude" || inGot != 120 || outGot != 45 || !floatEqual(costGot, 0.42) {
		t.Fatalf("unexpected row values: sprint=%s task=%s tool=%s in=%d out=%d cost=%f", sprintGot, taskGot, tool, inGot, outGot, costGot)
	}
}

func TestSprintTotal(t *testing.T) {
	f := setupCostFixture(t)
	sprintID, taskID := f.seedSprintTask(t)

	for _, c := range []float64{0.10, 0.20, 0.30} {
		if err := f.tracker.Record(sprintID, taskID, "claude", 1, 1, c); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}

	total, err := f.tracker.SprintTotal(sprintID)
	if err != nil {
		t.Fatalf("SprintTotal: %v", err)
	}
	if !floatEqual(total, 0.60) {
		t.Fatalf("SprintTotal = %.2f, want 0.60", total)
	}
}

func TestProjectTotal(t *testing.T) {
	f := setupCostFixture(t)
	s1, t1 := f.seedSprintTask(t)
	s2, t2 := f.seedSprintTask(t)

	if err := f.tracker.Record(s1, t1, "claude", 1, 1, 1.25); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if err := f.tracker.Record(s2, t2, "codex", 1, 1, 2.75); err != nil {
		t.Fatalf("Record: %v", err)
	}

	total, err := f.tracker.ProjectTotal()
	if err != nil {
		t.Fatalf("ProjectTotal: %v", err)
	}
	if !floatEqual(total, 4.00) {
		t.Fatalf("ProjectTotal = %.2f, want 4.00", total)
	}
}

func TestBudgetRemaining(t *testing.T) {
	f := setupCostFixture(t)
	sprintID, taskID := f.seedSprintTask(t)

	if err := f.tracker.Record(sprintID, taskID, "claude", 1, 1, 2.50); err != nil {
		t.Fatalf("Record: %v", err)
	}

	remaining, err := f.tracker.BudgetRemaining(5.00)
	if err != nil {
		t.Fatalf("BudgetRemaining: %v", err)
	}
	if !floatEqual(remaining, 2.50) {
		t.Fatalf("BudgetRemaining(5.00) = %.2f, want 2.50", remaining)
	}

	remaining, err = f.tracker.BudgetRemaining(0)
	if err != nil {
		t.Fatalf("BudgetRemaining(0): %v", err)
	}
	if !floatEqual(remaining, 0) {
		t.Fatalf("BudgetRemaining(0) = %.2f, want 0", remaining)
	}
}

func TestCheckBudget(t *testing.T) {
	f := setupCostFixture(t)
	sprintID, taskID := f.seedSprintTask(t)

	if err := f.tracker.Record(sprintID, taskID, "claude", 1, 1, 5.00); err != nil {
		t.Fatalf("Record: %v", err)
	}

	err := f.tracker.CheckBudget(5.00)
	if err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("CheckBudget(5.00) error = %v, want exceeded error", err)
	}

	if err := f.tracker.CheckBudget(10.00); err != nil {
		t.Fatalf("CheckBudget(10.00) = %v, want nil", err)
	}
	if err := f.tracker.CheckBudget(0); err != nil {
		t.Fatalf("CheckBudget(0) = %v, want nil", err)
	}
}

func TestSprintSummary(t *testing.T) {
	f := setupCostFixture(t)
	sprintID, taskID := f.seedSprintTask(t)
	_, taskID2 := f.seedSprintTask(t)

	if err := f.tracker.Record(sprintID, taskID, "claude", 100, 40, 0.50); err != nil {
		t.Fatalf("Record 1: %v", err)
	}
	if err := f.tracker.Record(sprintID, taskID2, "claude", 10, 5, 0.10); err != nil {
		t.Fatalf("Record 2: %v", err)
	}
	if err := f.tracker.Record(sprintID, taskID, "codex", 20, 30, 0.20); err != nil {
		t.Fatalf("Record 3: %v", err)
	}

	summary, err := f.tracker.SprintSummary(sprintID)
	if err != nil {
		t.Fatalf("SprintSummary: %v", err)
	}
	if len(summary) != 2 {
		t.Fatalf("SprintSummary entries = %d, want 2", len(summary))
	}

	byTool := map[string]ToolSummary{}
	for _, s := range summary {
		byTool[s.Tool] = s
	}

	claude := byTool["claude"]
	if claude.InputTokens != 110 || claude.OutputTokens != 45 || !floatEqual(claude.Cost, 0.60) {
		t.Fatalf("claude summary = %+v, want input=110 output=45 cost=0.60", claude)
	}
	codex := byTool["codex"]
	if codex.InputTokens != 20 || codex.OutputTokens != 30 || !floatEqual(codex.Cost, 0.20) {
		t.Fatalf("codex summary = %+v, want input=20 output=30 cost=0.20", codex)
	}
}

func TestProjectSummary(t *testing.T) {
	f := setupCostFixture(t)
	s1, t1 := f.seedSprintTask(t)
	s2, t2 := f.seedSprintTask(t)

	if err := f.tracker.Record(s1, t1, "claude", 10, 20, 0.30); err != nil {
		t.Fatalf("Record 1: %v", err)
	}
	if err := f.tracker.Record(s2, t2, "claude", 20, 40, 0.70); err != nil {
		t.Fatalf("Record 2: %v", err)
	}
	if err := f.tracker.Record(s2, t2, "codex", 5, 8, 0.10); err != nil {
		t.Fatalf("Record 3: %v", err)
	}

	summary, err := f.tracker.ProjectSummary()
	if err != nil {
		t.Fatalf("ProjectSummary: %v", err)
	}
	if len(summary) != 2 {
		t.Fatalf("ProjectSummary entries = %d, want 2", len(summary))
	}

	byTool := map[string]ToolSummary{}
	for _, s := range summary {
		byTool[s.Tool] = s
	}

	claude := byTool["claude"]
	if claude.InputTokens != 30 || claude.OutputTokens != 60 || !floatEqual(claude.Cost, 1.00) {
		t.Fatalf("claude summary = %+v, want input=30 output=60 cost=1.00", claude)
	}
	codex := byTool["codex"]
	if codex.InputTokens != 5 || codex.OutputTokens != 8 || !floatEqual(codex.Cost, 0.10) {
		t.Fatalf("codex summary = %+v, want input=5 output=8 cost=0.10", codex)
	}
}

func TestParseClaudeCost(t *testing.T) {
	// Real Claude envelope with cache tokens.
	in, out, cost, err := ParseClaudeCost(`{"type":"result","subtype":"success","result":"analysis","total_cost_usd":0.03254575,"usage":{"input_tokens":3,"cache_creation_input_tokens":2913,"cache_read_input_tokens":18751,"output_tokens":188}}`)
	if err != nil {
		t.Fatalf("ParseClaudeCost(real envelope): %v", err)
	}
	wantIn := int64(3 + 2913 + 18751)
	if in != wantIn || out != 188 || !floatEqual(cost, 0.03254575) {
		t.Fatalf("real envelope parse = (%d,%d,%f), want (%d,188,0.03254575)", in, out, cost, wantIn)
	}

	// Simple case with only input/output tokens.
	in, out, cost, err = ParseClaudeCost(`{"usage":{"input_tokens":12,"output_tokens":34},"total_cost_usd":0.56}`)
	if err != nil {
		t.Fatalf("ParseClaudeCost(simple): %v", err)
	}
	if in != 12 || out != 34 || !floatEqual(cost, 0.56) {
		t.Fatalf("simple parse = (%d,%d,%.2f), want (12,34,0.56)", in, out, cost)
	}

	in, out, cost, err = ParseClaudeCost("{not-json")
	if err != nil {
		t.Fatalf("ParseClaudeCost(invalid json): %v", err)
	}
	if in != 0 || out != 0 || !floatEqual(cost, 0) {
		t.Fatalf("invalid json parse = (%d,%d,%.2f), want zeros", in, out, cost)
	}

	in, out, cost, err = ParseClaudeCost(`{"usage":{},"total_cost_usd":0}`)
	if err != nil {
		t.Fatalf("ParseClaudeCost(missing usage fields): %v", err)
	}
	if in != 0 || out != 0 || !floatEqual(cost, 0) {
		t.Fatalf("missing usage parse = (%d,%d,%.2f), want zeros", in, out, cost)
	}

	in, out, cost, err = ParseClaudeCost("")
	if err != nil {
		t.Fatalf("ParseClaudeCost(empty): %v", err)
	}
	if in != 0 || out != 0 || !floatEqual(cost, 0) {
		t.Fatalf("empty parse = (%d,%d,%.2f), want zeros", in, out, cost)
	}
}

func TestParseGenericCost(t *testing.T) {
	in, out, cost, err := ParseGenericCost("anything")
	if err != nil {
		t.Fatalf("ParseGenericCost: %v", err)
	}
	if in != 0 || out != 0 || !floatEqual(cost, 0) {
		t.Fatalf("ParseGenericCost = (%d,%d,%.2f), want zeros", in, out, cost)
	}
}
