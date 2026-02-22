// Package task handles backlog CRUD, dependency graph, and sprint batching.
package task

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/state"
)

type Task struct {
	ID           string          `json:"id"`
	Title        string          `json:"title"`
	Description  string          `json:"description"`
	Prompt       string          `json:"prompt,omitempty"`
	Model        string          `json:"model,omitempty"`
	PhaseConfig  *PhaseConfigMap `json:"phase_config,omitempty"`
	Plan         string          `json:"plan,omitempty"`
	SessionID    string          `json:"session_id,omitempty"`
	ParentID     string          `json:"parent_id,omitempty"`
	Status       string          `json:"status"`
	AssignedTool string          `json:"assigned_tool,omitempty"`
	SprintID     string          `json:"sprint_id,omitempty"`
	DependsOn    []string        `json:"depends_on"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

type PhaseOverride struct {
	Tool  string `json:"tool,omitempty"`
	Model string `json:"model,omitempty"`
}

type PhaseConfigMap struct {
	UseDefaults bool                     `json:"use_defaults"`
	Phases      map[string]PhaseOverride `json:"phases,omitempty"` // keys: "plan", "sprint", "review"
}

type TaskReview struct {
	ID          string     `json:"id"`
	TaskID      string     `json:"task_id"`
	Feedback    string     `json:"feedback"`
	Status      string     `json:"status"` // "pending" | "addressed"
	CreatedAt   time.Time  `json:"created_at"`
	AddressedAt *time.Time `json:"addressed_at,omitempty"`
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
		`SELECT id, title, description, prompt, model, phase_config, plan, session_id, parent_id, status, assigned_tool, sprint_id, created_at, updated_at
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
		`SELECT id, title, description, prompt, model, phase_config, plan, session_id, parent_id, status, assigned_tool, sprint_id, created_at, updated_at
		 FROM tasks ORDER BY created_at`,
	)
}

func (s *Store) ListByStatus(status string) ([]*Task, error) {
	return s.queryTasks(
		`SELECT id, title, description, prompt, model, phase_config, plan, session_id, parent_id, status, assigned_tool, sprint_id, created_at, updated_at
		 FROM tasks WHERE status = ? ORDER BY created_at`, status,
	)
}

func (s *Store) Update(id string, fields map[string]interface{}) error {
	if len(fields) == 0 {
		return nil
	}
	if err := normalizePhaseConfigField(fields); err != nil {
		return err
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
	deps, err := s.loadDeps(taskID)
	if err != nil {
		return err
	}
	deps = append(deps, dependsOnID)
	if err := s.UpdateDependencies(taskID, deps); err != nil {
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

// UpdateDependencies replaces all dependencies for taskID.
// It rejects updates that introduce dependency cycles.
func (s *Store) UpdateDependencies(taskID string, deps []string) error {
	graph, err := s.loadDependencyGraph()
	if err != nil {
		return err
	}

	normalized := normalizeDeps(deps)
	graph[taskID] = normalized

	if cycle, ok := detectDependencyCycle(graph); ok {
		return fmt.Errorf("circular dependency: %s", strings.Join(cycle, " -> "))
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("update dependencies begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM task_deps WHERE task_id = ?`, taskID); err != nil {
		return fmt.Errorf("update dependencies delete existing: %w", err)
	}

	for _, dep := range normalized {
		if _, err := tx.Exec(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`, taskID, dep); err != nil {
			return fmt.Errorf("update dependencies insert %s -> %s: %w", taskID, dep, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("update dependencies commit: %w", err)
	}
	return nil
}

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
	return deref(plan), nil
}

// GetReady returns all pending tasks whose deps are all merged (or have no deps).
// Tasks with deps that are only "completed" but not yet merged are NOT ready —
// the dependent task needs the dep's code in the integration branch.
func (s *Store) GetReady() ([]*Task, error) {
	return s.queryTasks(
		`SELECT t.id, t.title, t.description, t.prompt, t.model, t.phase_config, t.plan, t.session_id, t.parent_id, t.status, t.assigned_tool, t.sprint_id, t.created_at, t.updated_at
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

func (s *Store) AddReview(taskID, feedback string) (string, error) {
	id := uuid.New().String()
	_, err := s.db.Exec(
		`INSERT INTO task_reviews (id, task_id, feedback, status) VALUES (?, ?, ?, 'pending')`,
		id, taskID, feedback,
	)
	if err != nil {
		return "", fmt.Errorf("add task review: %w", err)
	}
	return id, nil
}

func (s *Store) GetPendingReview(taskID string) (id, feedback string, err error) {
	err = s.db.QueryRow(
		`SELECT id, feedback
		 FROM task_reviews
		 WHERE task_id = ? AND status = 'pending'
		 ORDER BY created_at DESC
		 LIMIT 1`,
		taskID,
	).Scan(&id, &feedback)
	if err != nil {
		return "", "", err
	}
	return id, feedback, nil
}

func (s *Store) AddressReview(reviewID string) error {
	_, err := s.db.Exec(
		`UPDATE task_reviews
		 SET status = 'addressed', addressed_at = ?
		 WHERE id = ?`,
		time.Now().UTC(), reviewID,
	)
	if err != nil {
		return fmt.Errorf("address task review: %w", err)
	}
	return nil
}

func (s *Store) ListReviews(taskID string) ([]TaskReview, error) {
	rows, err := s.db.Query(
		`SELECT id, task_id, feedback, status, created_at, addressed_at
		 FROM task_reviews
		 WHERE task_id = ?
		 ORDER BY created_at`,
		taskID,
	)
	if err != nil {
		return nil, fmt.Errorf("list task reviews: %w", err)
	}
	defer rows.Close()

	var reviews []TaskReview
	for rows.Next() {
		var review TaskReview
		var addressedAt sql.NullTime
		if err := rows.Scan(
			&review.ID,
			&review.TaskID,
			&review.Feedback,
			&review.Status,
			&review.CreatedAt,
			&addressedAt,
		); err != nil {
			return nil, fmt.Errorf("scan task review: %w", err)
		}
		if addressedAt.Valid {
			review.AddressedAt = &addressedAt.Time
		}
		reviews = append(reviews, review)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate task reviews: %w", err)
	}
	return reviews, nil
}

// --- helpers ---

func (s *Store) scanTask(query string, args ...interface{}) (*Task, error) {
	row := s.db.QueryRow(query, args...)
	var t Task
	var desc, prompt, model, phaseConfig, plan, sessionID, parentID, tool, sprintID *string
	err := row.Scan(&t.ID, &t.Title, &desc, &prompt, &model, &phaseConfig, &plan, &sessionID, &parentID, &t.Status, &tool, &sprintID, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	t.Description = deref(desc)
	t.Prompt = deref(prompt)
	t.Model = deref(model)
	t.PhaseConfig = parsePhaseConfig(phaseConfig)
	t.Plan = deref(plan)
	t.SessionID = deref(sessionID)
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
		var desc, prompt, model, phaseConfig, plan, sessionID, parentID, tool, sprintID *string
		if err := rows.Scan(&t.ID, &t.Title, &desc, &prompt, &model, &phaseConfig, &plan, &sessionID, &parentID, &t.Status, &tool, &sprintID, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		t.Description = deref(desc)
		t.Prompt = deref(prompt)
		t.Model = deref(model)
		t.PhaseConfig = parsePhaseConfig(phaseConfig)
		t.Plan = deref(plan)
		t.SessionID = deref(sessionID)
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

func (s *Store) loadDependencyGraph() (map[string][]string, error) {
	rows, err := s.db.Query(`SELECT id FROM tasks`)
	if err != nil {
		return nil, fmt.Errorf("load dependency graph tasks: %w", err)
	}
	defer rows.Close()

	graph := make(map[string][]string)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan dependency graph task: %w", err)
		}
		graph[id] = nil
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate dependency graph tasks: %w", err)
	}

	rows, err = s.db.Query(`SELECT task_id, depends_on FROM task_deps`)
	if err != nil {
		return nil, fmt.Errorf("load dependency graph edges: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var taskID, depID string
		if err := rows.Scan(&taskID, &depID); err != nil {
			return nil, fmt.Errorf("scan dependency graph edge: %w", err)
		}
		graph[taskID] = append(graph[taskID], depID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate dependency graph edges: %w", err)
	}

	for id := range graph {
		slices.Sort(graph[id])
	}
	return graph, nil
}

func normalizeDeps(deps []string) []string {
	if len(deps) == 0 {
		return nil
	}

	seen := make(map[string]struct{}, len(deps))
	out := make([]string, 0, len(deps))
	for _, dep := range deps {
		if dep == "" {
			continue
		}
		if _, ok := seen[dep]; ok {
			continue
		}
		seen[dep] = struct{}{}
		out = append(out, dep)
	}
	slices.Sort(out)
	return out
}

func detectDependencyCycle(graph map[string][]string) ([]string, bool) {
	const (
		stateUnvisited = 0
		stateVisiting  = 1
		stateDone      = 2
	)

	nodes := make([]string, 0, len(graph))
	for id := range graph {
		nodes = append(nodes, id)
	}
	slices.Sort(nodes)

	state := make(map[string]int, len(graph))
	stack := make([]string, 0, len(graph))
	stackIndex := make(map[string]int, len(graph))

	var visit func(string) ([]string, bool)
	visit = func(node string) ([]string, bool) {
		state[node] = stateVisiting
		stackIndex[node] = len(stack)
		stack = append(stack, node)

		for _, dep := range graph[node] {
			if _, ok := graph[dep]; !ok {
				continue
			}
			switch state[dep] {
			case stateUnvisited:
				if cycle, ok := visit(dep); ok {
					return cycle, true
				}
			case stateVisiting:
				start := stackIndex[dep]
				cycle := append([]string{}, stack[start:]...)
				cycle = append(cycle, dep)
				return cycle, true
			}
		}

		stack = stack[:len(stack)-1]
		delete(stackIndex, node)
		state[node] = stateDone
		return nil, false
	}

	for _, node := range nodes {
		if state[node] != stateUnvisited {
			continue
		}
		if cycle, ok := visit(node); ok {
			return cycle, true
		}
	}
	return nil, false
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
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

func normalizePhaseConfigField(fields map[string]interface{}) error {
	v, ok := fields["phase_config"]
	if !ok || v == nil {
		return nil
	}

	var data []byte
	var err error
	switch pc := v.(type) {
	case PhaseConfigMap:
		data, err = json.Marshal(pc)
	case *PhaseConfigMap:
		data, err = json.Marshal(pc)
	case map[string]interface{}:
		data, err = json.Marshal(pc)
	default:
		return nil
	}
	if err != nil {
		return fmt.Errorf("marshal phase_config: %w", err)
	}
	fields["phase_config"] = string(data)
	return nil
}
