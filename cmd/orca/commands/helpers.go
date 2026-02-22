package commands

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
)

func statusIcon(status string) string {
	switch status {
	case "completed":
		return "✓"
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

func createOperation(db *state.DB, opType, targetID string) (string, error) {
	id := uuid.New().String()
	now := time.Now().UTC()
	_, err := db.Exec(
		`INSERT INTO operations (id, type, target_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)`,
		id, opType, targetID, now, now,
	)
	if err != nil {
		return "", err
	}
	return id, nil
}

func completeOperation(db *state.DB, id string, result interface{}) error {
	resultJSON, err := marshalOperationResult(result)
	if err != nil {
		return err
	}
	_, err = db.Exec(
		`UPDATE operations SET status = 'completed', result = ?, error = NULL, updated_at = ? WHERE id = ?`,
		resultJSON, time.Now().UTC(), id,
	)
	return err
}

func failOperation(db *state.DB, id, errMsg string) error {
	_, err := db.Exec(
		`UPDATE operations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
		errMsg, time.Now().UTC(), id,
	)
	return err
}

func marshalOperationResult(result interface{}) (string, error) {
	if result == nil {
		return "", nil
	}
	switch v := result.(type) {
	case string:
		return v, nil
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return "", fmt.Errorf("marshal operation result: %w", err)
		}
		return string(data), nil
	}
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
