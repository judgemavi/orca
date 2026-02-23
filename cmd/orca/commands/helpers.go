package commands

import (
	"fmt"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
)

func statusIcon(status string) string {
	switch status {
	case "approved":
		return "✓"
	case "decomposed":
		return "◈"
	case "running", "in_sprint":
		return "●"
	case "failed":
		return "✗"
	default:
		return "○"
	}
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func allTasks(_ *task.Task) bool      { return true }
func failedTasks(t *task.Task) bool   { return t.Status == "failed" }
func approvedTasks(t *task.Task) bool { return t.Status == "approved" }
func reviewTasks(t *task.Task) bool   { return t.Status == "review" }
func pendingTasks(t *task.Task) bool  { return t.Status == "pending" }

func pickTask(store *task.Store, title string, filter func(*task.Task) bool) (string, error) {
	tasks, err := store.List()
	if err != nil {
		return "", err
	}

	opts := make([]huh.Option[string], 0, len(tasks))
	for _, t := range tasks {
		if !filter(t) {
			continue
		}
		label := fmt.Sprintf("%s  %s (%s)", short(t.ID), t.Title, t.Status)
		opts = append(opts, huh.NewOption(label, t.ID))
	}
	if len(opts) == 0 {
		return "", fmt.Errorf("no tasks found")
	}

	var selected string
	if err := huh.NewSelect[string]().Title(title).Options(opts...).Value(&selected).Run(); err != nil {
		return "", err
	}
	return selected, nil
}

func pickTasks(store *task.Store, title string, filter func(*task.Task) bool) ([]string, error) {
	tasks, err := store.List()
	if err != nil {
		return nil, err
	}

	opts := make([]huh.Option[string], 0, len(tasks))
	for _, t := range tasks {
		if !filter(t) {
			continue
		}
		label := fmt.Sprintf("%s  %s (%s)", short(t.ID), t.Title, t.Status)
		opts = append(opts, huh.NewOption(label, t.ID).Selected(true))
	}
	if len(opts) == 0 {
		return nil, fmt.Errorf("no tasks found")
	}

	var selected []string
	if err := huh.NewMultiSelect[string]().Title(title).Options(opts...).Value(&selected).Run(); err != nil {
		return nil, err
	}
	if len(selected) == 0 {
		return nil, fmt.Errorf("no tasks selected")
	}
	return selected, nil
}

func resolveTaskID(store *task.Store, prefix string) (string, error) {
	id, err := store.ResolveID(prefix)
	if err != nil {
		return "", fmt.Errorf("resolve %q: %w", prefix, err)
	}
	return id, nil
}

type operationRow struct {
	ID        string
	Type      string
	TargetID  string
	Status    string
	Result    string
	Error     string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func ensureOperationsTable(db *state.DB) error {
	_, err := db.Exec(`
CREATE TABLE IF NOT EXISTS operations (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'running',
	result TEXT,
	error TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`)
	return err
}

func listOperations(db *state.DB, includeAll bool) ([]operationRow, error) {
	query := `SELECT id, type, target_id, status, COALESCE(result, ''), COALESCE(error, ''), created_at, updated_at
	          FROM operations`
	if !includeAll {
		query += ` WHERE status = 'running' OR updated_at >= datetime('now', '-5 minutes')`
	}
	query += ` ORDER BY created_at DESC`

	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []operationRow
	for rows.Next() {
		var row operationRow
		if err := rows.Scan(&row.ID, &row.Type, &row.TargetID, &row.Status, &row.Result, &row.Error, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func renderSpinner(label string, done <-chan struct{}) {
	frames := []rune{'|', '/', '-', '\\'}
	i := 0
	for {
		select {
		case <-done:
			fmt.Printf("\r%s... done\n", label)
			return
		default:
			fmt.Printf("\r%s... %c", label, frames[i%len(frames)])
			time.Sleep(120 * time.Millisecond)
			i++
		}
	}
}

func formatTokens(n int64) string {
	if n >= 1_000_000 {
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
	if n >= 1_000 {
		return formatWithCommas(n)
	}
	return fmt.Sprintf("%d", n)
}

func formatWithCommas(n int64) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var result []byte
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			result = append(result, ',')
		}
		result = append(result, byte(c))
	}
	return string(result)
}
