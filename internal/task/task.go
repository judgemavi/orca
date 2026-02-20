// Package task handles backlog CRUD, dependency graph, and sprint batching.
package task

import (
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/pod/internal/state"
)

type Task struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	Description  string    `json:"description"`
	Prompt       string    `json:"prompt,omitempty"`
	Model        string    `json:"model,omitempty"`
	Plan         string    `json:"plan,omitempty"`
	ParentID     string    `json:"parent_id,omitempty"`
	Status       string    `json:"status"`
	AssignedTool string    `json:"assigned_tool,omitempty"`
	SprintID     string    `json:"sprint_id,omitempty"`
	DependsOn    []string  `json:"depends_on"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Store struct {
	db *state.DB
}

func NewStore(db *state.DB) *Store {
	return &Store{db: db}
}

func (s *Store) Create(title, description, parentID, assignedTool string) (*Task, error) {
	id := uuid.New().String()
	now := time.Now().UTC()

	var parent *string
	if parentID != "" {
		parent = &parentID
	}

	var tool *string
	if assignedTool != "" {
		tool = &assignedTool
	}

	_, err := s.db.Exec(
		`INSERT INTO tasks (id, title, description, parent_id, assigned_tool, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
		id, title, description, parent, tool, now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("create task: %w", err)
	}

	return &Task{
		ID:           id,
		Title:        title,
		Description:  description,
		ParentID:     parentID,
		AssignedTool: assignedTool,
		Status:       "pending",
		CreatedAt:    now,
		UpdatedAt:    now,
	}, nil
}

func (s *Store) Get(id string) (*Task, error) {
	t, err := s.scanTask(
		`SELECT id, title, description, prompt, model, plan, parent_id, status, assigned_tool, sprint_id, created_at, updated_at
		 FROM tasks WHERE id = ?`, id,
	)
	if err != nil {
		return nil, fmt.Errorf("get task: %w", err)
	}

	deps, err := s.loadDeps(id)
	if err != nil {
		return nil, err
	}
	t.DependsOn = deps
	return t, nil
}

func (s *Store) List() ([]*Task, error) {
	return s.queryTasks(
		`SELECT id, title, description, prompt, model, plan, parent_id, status, assigned_tool, sprint_id, created_at, updated_at
		 FROM tasks ORDER BY created_at`,
	)
}

func (s *Store) ListByStatus(status string) ([]*Task, error) {
	return s.queryTasks(
		`SELECT id, title, description, prompt, model, plan, parent_id, status, assigned_tool, sprint_id, created_at, updated_at
		 FROM tasks WHERE status = ? ORDER BY created_at`, status,
	)
}

func (s *Store) Update(id string, fields map[string]interface{}) error {
	if len(fields) == 0 {
		return nil
	}

	setClauses := make([]string, 0, len(fields)+1)
	args := make([]interface{}, 0, len(fields)+2)

	for col, val := range fields {
		setClauses = append(setClauses, col+" = ?")
		args = append(args, val)
	}

	setClauses = append(setClauses, "updated_at = ?")
	args = append(args, time.Now().UTC())
	args = append(args, id)

	query := fmt.Sprintf("UPDATE tasks SET %s WHERE id = ?", strings.Join(setClauses, ", "))
	res, err := s.db.Exec(query, args...)
	if err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("update task rows affected: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("task %s not found", id)
	}
	return nil
}

func (s *Store) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM task_deps WHERE task_id = ? OR depends_on = ?`, id, id)
	if err != nil {
		return fmt.Errorf("delete task deps: %w", err)
	}
	_, err = s.db.Exec(`DELETE FROM tasks WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	return nil
}

func (s *Store) AddDependency(taskID, dependsOnID string) error {
	_, err := s.db.Exec(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`, taskID, dependsOnID)
	if err != nil {
		return fmt.Errorf("add dependency: %w", err)
	}
	return nil
}

func (s *Store) RemoveDependency(taskID, dependsOnID string) error {
	_, err := s.db.Exec(`DELETE FROM task_deps WHERE task_id = ? AND depends_on = ?`, taskID, dependsOnID)
	if err != nil {
		return fmt.Errorf("remove dependency: %w", err)
	}
	return nil
}

func (s *Store) SetPlan(id, content string) error {
	return s.Update(id, map[string]interface{}{"plan": content})
}

func (s *Store) GetPlan(id string) (string, error) {
	var plan *string
	if err := s.db.QueryRow(`SELECT plan FROM tasks WHERE id = ?`, id).Scan(&plan); err != nil {
		return "", fmt.Errorf("get task plan: %w", err)
	}
	return deref(plan), nil
}

// GetReady returns all pending tasks whose deps are all merged (or have no deps).
// Tasks with deps that are only "completed" but not yet merged are NOT ready —
// the dependent task needs the dep's code in the integration branch.
func (s *Store) GetReady() ([]*Task, error) {
	return s.queryTasks(
		`SELECT t.id, t.title, t.description, t.prompt, t.model, t.plan, t.parent_id, t.status, t.assigned_tool, t.sprint_id, t.created_at, t.updated_at
		 FROM tasks t
		 WHERE t.status = 'pending'
		   AND NOT EXISTS (
		     SELECT 1 FROM task_deps d
		     JOIN tasks dep ON dep.id = d.depends_on
		     WHERE d.task_id = t.id AND dep.status != 'merged'
		   )
		 ORDER BY t.created_at`,
	)
}

// DepsMetOrInSprint returns true if all of the task's dependencies are merged.
// Tasks in the same sprint are NOT considered met — deps must be merged into
// the integration branch so worktrees have the actual code.
func (s *Store) DepsMetOrInSprint(taskID, sprintID string) (bool, []string, error) {
	rows, err := s.db.Query(
		`SELECT d.depends_on, dep.status, dep.sprint_id
		 FROM task_deps d
		 JOIN tasks dep ON dep.id = d.depends_on
		 WHERE d.task_id = ?`,
		taskID,
	)
	if err != nil {
		return false, nil, fmt.Errorf("query deps: %w", err)
	}
	defer rows.Close()

	var unmet []string
	for rows.Next() {
		var depID, depStatus string
		var depSprintID *string
		if err := rows.Scan(&depID, &depStatus, &depSprintID); err != nil {
			return false, nil, fmt.Errorf("scan deps: %w", err)
		}
		_ = depSprintID // no longer used — only merged status counts
		if depStatus != "merged" {
			unmet = append(unmet, depID)
		}
	}
	if err := rows.Err(); err != nil {
		return false, nil, fmt.Errorf("iterate deps: %w", err)
	}

	return len(unmet) == 0, unmet, nil
}

// ResolveID resolves a prefix to a full task ID.
// Passthrough if already 36 chars. Returns error on 0 or 2+ matches.
func (s *Store) ResolveID(prefix string) (string, error) {
	if len(prefix) == 36 {
		return prefix, nil
	}
	rows, err := s.db.Query(`SELECT id FROM tasks WHERE id LIKE ?||'%'`, prefix)
	if err != nil {
		return "", fmt.Errorf("resolve id: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", fmt.Errorf("scan id: %w", err)
		}
		ids = append(ids, id)
	}
	switch len(ids) {
	case 0:
		return "", fmt.Errorf("no task matching prefix %q", prefix)
	case 1:
		return ids[0], nil
	default:
		return "", fmt.Errorf("ambiguous prefix %q matches %d tasks", prefix, len(ids))
	}
}

// --- helpers ---

func (s *Store) scanTask(query string, args ...interface{}) (*Task, error) {
	row := s.db.QueryRow(query, args...)
	var t Task
	var desc, prompt, model, plan, parentID, tool, sprintID *string
	err := row.Scan(&t.ID, &t.Title, &desc, &prompt, &model, &plan, &parentID, &t.Status, &tool, &sprintID, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	t.Description = deref(desc)
	t.Prompt = deref(prompt)
	t.Model = deref(model)
	t.Plan = deref(plan)
	t.ParentID = deref(parentID)
	t.AssignedTool = deref(tool)
	t.SprintID = deref(sprintID)
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
		var desc, prompt, model, plan, parentID, tool, sprintID *string
		if err := rows.Scan(&t.ID, &t.Title, &desc, &prompt, &model, &plan, &parentID, &t.Status, &tool, &sprintID, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		t.Description = deref(desc)
		t.Prompt = deref(prompt)
		t.Model = deref(model)
		t.Plan = deref(plan)
		t.ParentID = deref(parentID)
		t.AssignedTool = deref(tool)
		t.SprintID = deref(sprintID)
		tasks = append(tasks, &t)
	}

	// Load deps for each task.
	for _, t := range tasks {
		deps, err := s.loadDeps(t.ID)
		if err != nil {
			return nil, err
		}
		t.DependsOn = deps
	}

	return tasks, nil
}

func (s *Store) loadDeps(taskID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT depends_on FROM task_deps WHERE task_id = ?`, taskID)
	if err != nil {
		return nil, fmt.Errorf("load deps: %w", err)
	}
	defer rows.Close()

	var deps []string
	for rows.Next() {
		var dep string
		if err := rows.Scan(&dep); err != nil {
			return nil, fmt.Errorf("scan dep: %w", err)
		}
		deps = append(deps, dep)
	}
	return deps, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
