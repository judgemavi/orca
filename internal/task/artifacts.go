package task

import (
	"database/sql"
	"fmt"
	"time"
)

type Artifact struct {
	ID         string    `json:"id"`
	TaskID     string    `json:"task_id"`
	RunID      *string   `json:"run_id,omitempty"`
	Diff       string    `json:"diff"`
	Stdout     string    `json:"stdout"`
	Stderr     string    `json:"stderr"`
	ExitCode   int       `json:"exit_code"`
	DurationMS int       `json:"duration_ms"`
	CreatedAt  time.Time `json:"created_at"`
}

func (s *Store) ListArtifacts(taskID string) ([]Artifact, error) {
	rows, err := s.db.Query(
		`SELECT id, task_id, run_id, diff, stdout, stderr, exit_code, duration_ms, created_at
		 FROM artifacts
		 WHERE task_id = ?
		 ORDER BY created_at DESC`,
		taskID,
	)
	if err != nil {
		return nil, fmt.Errorf("list task artifacts: %w", err)
	}
	defer rows.Close()

	var artifacts []Artifact
	for rows.Next() {
		var artifact Artifact
		var runID sql.NullString
		var diff sql.NullString
		var stdout sql.NullString
		var stderr sql.NullString
		var exitCode sql.NullInt64
		var durationMS sql.NullInt64

		if err := rows.Scan(
			&artifact.ID,
			&artifact.TaskID,
			&runID,
			&diff,
			&stdout,
			&stderr,
			&exitCode,
			&durationMS,
			&artifact.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan task artifact: %w", err)
		}

		if runID.Valid {
			artifact.RunID = &runID.String
		}
		artifact.Diff = diff.String
		artifact.Stdout = stdout.String
		artifact.Stderr = stderr.String
		if exitCode.Valid {
			artifact.ExitCode = int(exitCode.Int64)
		}
		if durationMS.Valid {
			artifact.DurationMS = int(durationMS.Int64)
		}
		artifacts = append(artifacts, artifact)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate task artifacts: %w", err)
	}
	return artifacts, nil
}
