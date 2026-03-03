package state

import (
	"database/sql"
	"time"
)

// OrchestratorSessionRow is a persisted orchestrator chat session.
type OrchestratorSessionRow struct {
	ID              string
	Tool            string
	Model           string
	ClaudeSessionID string
	Status          string
	CreatedAt       time.Time
}

// OrchestratorMessageRow is one persisted orchestrator chat message.
type OrchestratorMessageRow struct {
	ID        string
	SessionID string
	Role      string
	Content   string
	Metadata  string
	CreatedAt time.Time
}

// CreateOrchestratorSession inserts a new active orchestrator session.
func (db *DB) CreateOrchestratorSession(id, tool, model string) error {
	_, err := db.Exec(
		`INSERT INTO orchestrator_sessions (id, tool, model) VALUES (?, ?, ?)`,
		id, tool, model,
	)
	return err
}

// GetActiveOrchestratorSession returns the most recent active orchestrator session.
func (db *DB) GetActiveOrchestratorSession() (*OrchestratorSessionRow, error) {
	var row OrchestratorSessionRow
	err := db.QueryRow(
		`SELECT id, tool, model, claude_session_id, status, created_at
		 FROM orchestrator_sessions
		 WHERE status = 'active'
		 ORDER BY created_at DESC
		 LIMIT 1`,
	).Scan(
		&row.ID,
		&row.Tool,
		&row.Model,
		&row.ClaudeSessionID,
		&row.Status,
		&row.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// CloseOrchestratorSession marks an orchestrator session as closed.
func (db *DB) CloseOrchestratorSession(id string) error {
	_, err := db.Exec(
		`UPDATE orchestrator_sessions
		 SET status = 'closed'
		 WHERE id = ?`,
		id,
	)
	return err
}

// SetOrchestratorSessionResumeID updates stored resume/session id.
func (db *DB) SetOrchestratorSessionResumeID(id, claudeSessionID string) error {
	_, err := db.Exec(
		`UPDATE orchestrator_sessions
		 SET claude_session_id = ?
		 WHERE id = ?`,
		claudeSessionID, id,
	)
	return err
}

// InsertOrchestratorMessage inserts one orchestrator chat message.
func (db *DB) InsertOrchestratorMessage(id, sessionID, role, content, metadata string) error {
	_, err := db.Exec(
		`INSERT INTO orchestrator_messages (id, session_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)`,
		id, sessionID, role, content, metadata,
	)
	return err
}

// ListOrchestratorMessages returns all messages for a session in chronological order.
func (db *DB) ListOrchestratorMessages(sessionID string) ([]OrchestratorMessageRow, error) {
	rows, err := db.Query(
		`SELECT id, session_id, role, content, metadata, created_at
		 FROM orchestrator_messages
		 WHERE session_id = ?
		 ORDER BY created_at ASC, rowid ASC`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]OrchestratorMessageRow, 0)
	for rows.Next() {
		var row OrchestratorMessageRow
		if err := rows.Scan(
			&row.ID,
			&row.SessionID,
			&row.Role,
			&row.Content,
			&row.Metadata,
			&row.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
