package api

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/jasjeetmavi/orca/internal/ops"
)

func (s *Server) handleListOperations(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	targetID := strings.TrimSpace(r.URL.Query().Get("target_id"))
	opType := strings.TrimSpace(r.URL.Query().Get("type"))

	query := `
		SELECT id, type, target_id, status, result, error, created_at, updated_at
		FROM operations
		WHERE (
			status = 'running'
			OR (status IN ('completed', 'failed') AND updated_at >= datetime('now', '-5 minutes'))
		)
	`
	args := make([]interface{}, 0, 2)
	if opType == "decompose" {
		// Decompose proposals are persisted and should be restorable after reconnect/restart.
		query = `
			SELECT id, type, target_id, status, result, error, created_at, updated_at
			FROM operations
			WHERE type = 'decompose'
		`
	}
	if targetID != "" {
		query += " AND target_id = ?"
		args = append(args, targetID)
	}
	if opType != "" && opType != "decompose" {
		query += " AND type = ?"
		args = append(args, opType)
	}
	query += " ORDER BY updated_at DESC"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var operations []ops.Operation
	for rows.Next() {
		var op ops.Operation
		var result sql.NullString
		var errText sql.NullString
		if err := rows.Scan(
			&op.ID,
			&op.Type,
			&op.TargetID,
			&op.Status,
			&result,
			&errText,
			&op.CreatedAt,
			&op.UpdatedAt,
		); err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return
		}
		if result.Valid {
			op.Result = result.String
		}
		if errText.Valid {
			op.Error = errText.String
		}
		operations = append(operations, op)
	}
	if err := rows.Err(); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{"operations": operations})
}
