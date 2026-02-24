package task

import (
	"fmt"

	"github.com/jasjeetmavi/orca/internal/nullable"
)

func (s *Store) SetPlan(id, content string) error {
	return s.Update(id, map[string]interface{}{"plan": content})
}

func (s *Store) SetSessionID(id, sessionID string) error {
	return s.Update(id, map[string]interface{}{"session_id": sessionID})
}

func (s *Store) GetPlan(id string) (string, error) {
	var plan *string
	if err := s.db.QueryRow(`SELECT plan FROM tasks WHERE id = ?`, id).Scan(&plan); err != nil {
		return "", fmt.Errorf("get task plan: %w", err)
	}
	return nullable.Deref(plan), nil
}
