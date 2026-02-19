// Package cost tracks per-sprint and per-tool spend for budget enforcement.
package cost

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/pod/internal/state"
)

// Record represents a single cost entry.
type Record struct {
	ID            string
	SprintID      string
	TaskID        string
	Tool          string
	InputTokens   int64
	OutputTokens  int64
	EstimatedCost float64
	CreatedAt     time.Time
}

// ToolSummary aggregates cost data per tool.
type ToolSummary struct {
	Tool         string
	InputTokens  int64
	OutputTokens int64
	Cost         float64
}

// Tracker records and queries cost data.
type Tracker struct {
	db *state.DB
}

// NewTracker creates a Tracker backed by the given DB.
func NewTracker(db *state.DB) *Tracker {
	return &Tracker{db: db}
}

// Record inserts a cost record.
func (t *Tracker) Record(sprintID, taskID, tool string, inputTokens, outputTokens int64, cost float64) error {
	_, err := t.db.Exec(
		`INSERT INTO costs (id, sprint_id, task_id, tool, input_tokens, output_tokens, estimated_cost)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		uuid.New().String(), sprintID, taskID, tool, inputTokens, outputTokens, cost,
	)
	return err
}

// SprintTotal returns the total estimated cost for a sprint.
func (t *Tracker) SprintTotal(sprintID string) (float64, error) {
	var total *float64
	err := t.db.QueryRow(
		`SELECT SUM(estimated_cost) FROM costs WHERE sprint_id = ?`, sprintID,
	).Scan(&total)
	if err != nil {
		return 0, err
	}
	if total == nil {
		return 0, nil
	}
	return *total, nil
}

// ProjectTotal returns the total estimated cost across all sprints.
func (t *Tracker) ProjectTotal() (float64, error) {
	var total *float64
	err := t.db.QueryRow(`SELECT SUM(estimated_cost) FROM costs`).Scan(&total)
	if err != nil {
		return 0, err
	}
	if total == nil {
		return 0, nil
	}
	return *total, nil
}

// BudgetRemaining returns budget minus project total. If budget is 0, returns 0.
func (t *Tracker) BudgetRemaining(budget float64) (float64, error) {
	if budget <= 0 {
		return 0, nil
	}
	total, err := t.ProjectTotal()
	if err != nil {
		return 0, err
	}
	return budget - total, nil
}

// CheckBudget returns an error if the project total meets or exceeds the budget.
// If budget is 0, always returns nil (no budget set).
func (t *Tracker) CheckBudget(budget float64) error {
	if budget <= 0 {
		return nil
	}
	total, err := t.ProjectTotal()
	if err != nil {
		return err
	}
	if total >= budget {
		return fmt.Errorf("cost budget exceeded: spent $%.2f of $%.2f budget", total, budget)
	}
	return nil
}

// SprintSummary returns per-tool cost breakdown for a sprint.
func (t *Tracker) SprintSummary(sprintID string) ([]ToolSummary, error) {
	rows, err := t.db.Query(
		`SELECT tool, SUM(input_tokens), SUM(output_tokens), SUM(estimated_cost)
		 FROM costs WHERE sprint_id = ? GROUP BY tool`, sprintID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var summaries []ToolSummary
	for rows.Next() {
		var s ToolSummary
		if err := rows.Scan(&s.Tool, &s.InputTokens, &s.OutputTokens, &s.Cost); err != nil {
			return nil, err
		}
		summaries = append(summaries, s)
	}
	return summaries, nil
}

// ProjectSummary returns per-tool cost breakdown across the entire project.
func (t *Tracker) ProjectSummary() ([]ToolSummary, error) {
	rows, err := t.db.Query(
		`SELECT tool, SUM(input_tokens), SUM(output_tokens), SUM(estimated_cost)
		 FROM costs GROUP BY tool`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var summaries []ToolSummary
	for rows.Next() {
		var s ToolSummary
		if err := rows.Scan(&s.Tool, &s.InputTokens, &s.OutputTokens, &s.Cost); err != nil {
			return nil, err
		}
		summaries = append(summaries, s)
	}
	return summaries, nil
}

// claudeOutput represents the JSON structure from Claude's --output-format json.
type claudeOutput struct {
	Usage struct {
		InputTokens              int64 `json:"input_tokens"`
		CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
		CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		OutputTokens             int64 `json:"output_tokens"`
	} `json:"usage"`
	TotalCostUSD float64 `json:"total_cost_usd"`
}

// ParseClaudeCost parses cost info from Claude's JSON output.
// Returns zeros (not an error) if fields are missing or parse fails.
func ParseClaudeCost(stdout string) (inputTokens, outputTokens int64, cost float64, err error) {
	var out claudeOutput
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		return 0, 0, 0, nil
	}
	totalInput := out.Usage.InputTokens + out.Usage.CacheCreationInputTokens + out.Usage.CacheReadInputTokens
	return totalInput, out.Usage.OutputTokens, out.TotalCostUSD, nil
}

// ParseGenericCost is a fallback for tools that don't report cost in stdout.
// Always returns zeros.
func ParseGenericCost(stdout string) (inputTokens, outputTokens int64, cost float64, err error) {
	return 0, 0, 0, nil
}
