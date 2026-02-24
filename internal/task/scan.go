package task

import (
	"encoding/json"
	"fmt"

	"github.com/jasjeetmavi/orca/internal/nullable"
)

func (s *Store) scanTask(query string, args ...interface{}) (*Task, error) {
	row := s.db.QueryRow(query, args...)
	var t Task
	var desc, prompt, model, phaseConfig, plan, sessionID, parentID, tool, sprintID *string
	err := row.Scan(&t.ID, &t.Title, &desc, &prompt, &model, &phaseConfig, &plan, &sessionID, &parentID, &t.Status, &tool, &sprintID, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	t.Description = nullable.Deref(desc)
	t.Prompt = nullable.Deref(prompt)
	t.Model = nullable.Deref(model)
	t.PhaseConfig = parsePhaseConfig(phaseConfig)
	t.Plan = nullable.Deref(plan)
	t.SessionID = nullable.Deref(sessionID)
	t.ParentID = nullable.Deref(parentID)
	t.AssignedTool = nullable.Deref(tool)
	t.SprintID = nullable.Deref(sprintID)
	return &t, nil
}

func (s *Store) queryTasks(query string, args ...interface{}) ([]*Task, error) {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query tasks: %w", err)
	}
	defer rows.Close()

	var tasks []*Task
	for rows.Next() {
		var t Task
		var desc, prompt, model, phaseConfig, plan, sessionID, parentID, tool, sprintID *string
		if err := rows.Scan(&t.ID, &t.Title, &desc, &prompt, &model, &phaseConfig, &plan, &sessionID, &parentID, &t.Status, &tool, &sprintID, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		t.Description = nullable.Deref(desc)
		t.Prompt = nullable.Deref(prompt)
		t.Model = nullable.Deref(model)
		t.PhaseConfig = parsePhaseConfig(phaseConfig)
		t.Plan = nullable.Deref(plan)
		t.SessionID = nullable.Deref(sessionID)
		t.ParentID = nullable.Deref(parentID)
		t.AssignedTool = nullable.Deref(tool)
		t.SprintID = nullable.Deref(sprintID)
		tasks = append(tasks, &t)
	}

	depsByTask, err := s.loadDepsForTasks(tasks)
	if err != nil {
		return nil, err
	}
	for _, t := range tasks {
		t.DependsOn = depsByTask[t.ID]
	}

	return tasks, nil
}

func parsePhaseConfig(raw *string) *PhaseConfigMap {
	if raw == nil || *raw == "" {
		return nil
	}

	var pc PhaseConfigMap
	if err := json.Unmarshal([]byte(*raw), &pc); err != nil {
		return nil
	}
	return &pc
}
