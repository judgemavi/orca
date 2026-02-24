// Package task handles task CRUD and dependency graph.
package task

import (
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/state"
)

type Task struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Plan        string    `json:"plan,omitempty"`
	SessionID   string    `json:"session_id,omitempty"`
	ParentID    string    `json:"parent_id,omitempty"`
	Status      string    `json:"status"`
	DependsOn   []string  `json:"depends_on"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type TaskReview struct {
	ID            string     `json:"id"`
	TaskID        string     `json:"task_id"`
	InteractionID *string    `json:"interaction_id,omitempty"`
	Feedback      string     `json:"feedback"`
	Status        string     `json:"status"` // "pending" | "addressed"
	CreatedAt     time.Time  `json:"created_at"`
	AddressedAt   *time.Time `json:"addressed_at,omitempty"`
}

type Store struct {
	db *state.DB
}

func NewStore(db *state.DB) *Store {
	return &Store{db: db}
}

func (s *Store) Create(title, description, parentID string) (*Task, error) {
	id := uuid.New().String()
	now := time.Now().UTC()

	var parent *string
	if parentID != "" {
		parent = &parentID
	}

	_, err := s.db.Exec(
		`INSERT INTO tasks (id, title, description, parent_id, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
		id, title, description, parent, now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("create task: %w", err)
	}

	return &Task{
		ID:          id,
		Title:       title,
		Description: description,
		ParentID:    parentID,
		Status:      "pending",
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

func (s *Store) Get(id string) (*Task, error) {
	t, err := s.scanTask(
		`SELECT id, title, description, plan, session_id, parent_id, status, created_at, updated_at
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
		`SELECT id, title, description, plan, session_id, parent_id, status, created_at, updated_at
		 FROM tasks ORDER BY created_at`,
	)
}

func (s *Store) ListByStatus(status string) ([]*Task, error) {
	return s.queryTasks(
		`SELECT id, title, description, plan, session_id, parent_id, status, created_at, updated_at
		 FROM tasks WHERE status = ? ORDER BY created_at`, status,
	)
}

func (s *Store) ListByParent(parentID string) ([]*Task, error) {
	tasks, err := s.List()
	if err != nil {
		return nil, err
	}

	filtered := make([]*Task, 0, len(tasks))
	for _, t := range tasks {
		if t.ParentID == parentID {
			filtered = append(filtered, t)
		}
	}
	return filtered, nil
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

var deletableStatuses = map[string]bool{
	"pending":  true,
	"planned":  true,
	"review":   true,
	"approved": true,
	"failed":   true,
}

func (s *Store) Delete(id string) error {
	t, err := s.Get(id)
	if err != nil {
		return err
	}
	if !deletableStatuses[t.Status] {
		return fmt.Errorf("cannot delete task in %q status", t.Status)
	}

	// Block deletion if other tasks depend on this one.
	var depCount int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM task_deps WHERE depends_on = ?`, id).Scan(&depCount); err != nil {
		return fmt.Errorf("check dependents: %w", err)
	}
	if depCount > 0 {
		return fmt.Errorf("cannot delete task: %d other task(s) depend on it", depCount)
	}

	// Clean up all child records that reference this task.
	for _, q := range []struct {
		sql  string
		desc string
	}{
		{`DELETE FROM task_reviews WHERE task_id = ?`, "reviews"},
		{`DELETE FROM task_interactions WHERE task_id = ?`, "interactions"},
		{`DELETE FROM task_deps WHERE task_id = ?`, "deps"},
	} {
		if _, err := s.db.Exec(q.sql, id); err != nil {
			return fmt.Errorf("delete task %s: %w", q.desc, err)
		}
	}
	_, err = s.db.Exec(`DELETE FROM tasks WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	return nil
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
