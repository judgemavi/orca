// Package sprint manages sprint planning, execution coordination, and status tracking.
package sprint

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
)

type Sprint struct {
	ID          string     `json:"id"`
	Status      string     `json:"status"`
	TaskIDs     []string   `json:"task_ids"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

type EventFunc func(eventType string, id string)

// OrphanedTask represents a task that was running when Orca exited.
type OrphanedTask struct {
	TaskID       string
	SprintID     string
	WorktreePath string
	HasCommits   bool // true if worktree has commits beyond the base branch
}

type Planner struct {
	db      *state.DB
	tasks   *task.Store
	onEvent EventFunc
}

func NewPlanner(db *state.DB) *Planner {
	return &Planner{
		db:    db,
		tasks: task.NewStore(db),
	}
}

// DB returns the underlying database for direct queries.
func (p *Planner) DB() *state.DB { return p.db }

func (p *Planner) SetEventHook(fn EventFunc) { p.onEvent = fn }

func (p *Planner) emit(eventType, id string) {
	if p.onEvent != nil {
		p.onEvent(eventType, id)
	}
}

// Plan creates a new sprint from up to maxParallel ready tasks.
func (p *Planner) Plan(maxParallel int) (*Sprint, error) {
	ready, err := p.tasks.GetReady()
	if err != nil {
		return nil, fmt.Errorf("get ready tasks: %w", err)
	}
	if len(ready) == 0 {
		pending, err := p.tasks.ListByStatus("pending")
		if err != nil {
			return nil, fmt.Errorf("list pending tasks: %w", err)
		}
		if cycle, ok := detectTaskCycle(pending); ok {
			return nil, fmt.Errorf("circular dependency: %s", strings.Join(cycle, " -> "))
		}
		return nil, fmt.Errorf("no ready tasks")
	}

	if len(ready) > maxParallel {
		ready = ready[:maxParallel]
	}

	id := uuid.New().String()
	now := time.Now().UTC()

	_, err = p.db.Exec(
		`INSERT INTO sprints (id, status, created_at) VALUES (?, 'planning', ?)`,
		id, now,
	)
	if err != nil {
		return nil, fmt.Errorf("create sprint: %w", err)
	}

	taskIDs := make([]string, len(ready))
	for i, t := range ready {
		taskIDs[i] = t.ID
		if err := p.tasks.Update(t.ID, map[string]interface{}{
			"status":    "in_sprint",
			"sprint_id": id,
		}); err != nil {
			return nil, fmt.Errorf("update task %s: %w", t.ID, err)
		}
	}
	p.emit("sprint.planned", id)

	return &Sprint{
		ID:        id,
		Status:    "planning",
		TaskIDs:   taskIDs,
		CreatedAt: now,
	}, nil
}

func detectTaskCycle(tasks []*task.Task) ([]string, bool) {
	const (
		stateUnvisited = 0
		stateVisiting  = 1
		stateDone      = 2
	)

	graph := make(map[string][]string, len(tasks))
	for _, t := range tasks {
		graph[t.ID] = append([]string{}, t.DependsOn...)
	}
	for id := range graph {
		slices.Sort(graph[id])
	}

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

// CreateEmpty creates a sprint in "planning" status with no tasks.
func (p *Planner) CreateEmpty() (*Sprint, error) {
	id := uuid.New().String()
	now := time.Now().UTC()

	_, err := p.db.Exec(
		`INSERT INTO sprints (id, status, created_at) VALUES (?, 'planning', ?)`,
		id, now,
	)
	if err != nil {
		return nil, fmt.Errorf("create sprint: %w", err)
	}

	return &Sprint{
		ID:        id,
		Status:    "planning",
		TaskIDs:   []string{},
		CreatedAt: now,
	}, nil
}

// AddTaskToSprint moves a task into an existing planning sprint.
func (p *Planner) AddTaskToSprint(sprintID, taskID string) error {
	sp, err := p.Get(sprintID)
	if err != nil {
		return fmt.Errorf("get sprint: %w", err)
	}
	if sp.Status != "planning" {
		return fmt.Errorf("sprint %s is %s, must be planning", sprintID, sp.Status)
	}

	tk, err := p.tasks.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}
	if tk.Status != "pending" && tk.Status != "failed" {
		return fmt.Errorf("task %s status %q cannot be added to sprint", taskID, tk.Status)
	}
	if tk.SprintID != "" {
		return fmt.Errorf("task %s is already in sprint %s", taskID, tk.SprintID)
	}

	depsMet, unmet, err := p.tasks.DepsMetOrInSprint(taskID, sprintID)
	if err != nil {
		return fmt.Errorf("check dependencies: %w", err)
	}
	if !depsMet {
		return fmt.Errorf("task %s has unmet dependencies: %s", taskID, strings.Join(unmet, ", "))
	}

	if err := p.tasks.Update(taskID, map[string]interface{}{
		"status":    "in_sprint",
		"sprint_id": sprintID,
	}); err != nil {
		return fmt.Errorf("update task %s: %w", taskID, err)
	}

	return nil
}

// RemoveTaskFromSprint removes a task from a planning sprint and reverts it to pending.
func (p *Planner) RemoveTaskFromSprint(sprintID, taskID string) error {
	sp, err := p.Get(sprintID)
	if err != nil {
		return fmt.Errorf("get sprint: %w", err)
	}
	if sp.Status != "planning" {
		return fmt.Errorf("sprint %s is %s, must be planning", sprintID, sp.Status)
	}

	tk, err := p.tasks.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}
	if tk.SprintID != sprintID {
		return fmt.Errorf("task %s is not in sprint %s", taskID, sprintID)
	}

	rows, err := p.db.Query(
		`SELECT t.id
		 FROM tasks t
		 JOIN task_deps d ON d.task_id = t.id
		 WHERE t.sprint_id = ? AND d.depends_on = ?
		 ORDER BY t.created_at`,
		sprintID, taskID,
	)
	if err != nil {
		return fmt.Errorf("query dependent tasks: %w", err)
	}
	defer rows.Close()

	var dependentTaskIDs []string
	for rows.Next() {
		var dependentTaskID string
		if err := rows.Scan(&dependentTaskID); err != nil {
			return fmt.Errorf("scan dependent task id: %w", err)
		}
		dependentTaskIDs = append(dependentTaskIDs, dependentTaskID)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate dependent tasks: %w", err)
	}
	if len(dependentTaskIDs) > 0 {
		return fmt.Errorf("cannot remove task %s; dependent tasks in sprint: %s", taskID, strings.Join(dependentTaskIDs, ", "))
	}

	if err := p.tasks.Update(taskID, map[string]interface{}{
		"status":    "pending",
		"sprint_id": nil,
	}); err != nil {
		return fmt.Errorf("update task %s: %w", taskID, err)
	}

	return nil
}

// Start transitions a sprint from "planning" to "running" and marks its tasks as running.
func (p *Planner) Start(sprintID string) error {
	_, err := p.db.Exec(
		`UPDATE sprints SET status = 'running' WHERE id = ? AND status = 'planning'`,
		sprintID,
	)
	if err != nil {
		return fmt.Errorf("start sprint: %w", err)
	}

	_, err = p.db.Exec(
		`UPDATE tasks SET status = 'running', updated_at = ? WHERE sprint_id = ? AND status = 'in_sprint'`,
		time.Now().UTC(), sprintID,
	)
	if err != nil {
		return fmt.Errorf("start sprint tasks: %w", err)
	}
	p.emit("sprint.started", sprintID)
	return nil
}

// Complete marks a sprint as completed.
func (p *Planner) Complete(sprintID string) error {
	now := time.Now().UTC()
	_, err := p.db.Exec(
		`UPDATE sprints SET status = 'completed', completed_at = ? WHERE id = ?`,
		now, sprintID,
	)
	if err != nil {
		return fmt.Errorf("complete sprint: %w", err)
	}
	p.emit("sprint.completed", sprintID)
	return nil
}

// Fail marks a sprint as failed.
func (p *Planner) Fail(sprintID string) error {
	_, err := p.db.Exec(
		`UPDATE sprints SET status = 'failed' WHERE id = ?`,
		sprintID,
	)
	if err != nil {
		return fmt.Errorf("fail sprint: %w", err)
	}
	p.emit("sprint.failed", sprintID)
	return nil
}

// Get fetches a sprint and its associated task IDs.
func (p *Planner) Get(sprintID string) (*Sprint, error) {
	var s Sprint
	var completedAt *time.Time
	err := p.db.QueryRow(
		`SELECT id, status, created_at, completed_at FROM sprints WHERE id = ?`,
		sprintID,
	).Scan(&s.ID, &s.Status, &s.CreatedAt, &completedAt)
	if err != nil {
		return nil, fmt.Errorf("get sprint: %w", err)
	}
	s.CompletedAt = completedAt

	rows, err := p.db.Query(`SELECT id FROM tasks WHERE sprint_id = ? ORDER BY created_at`, sprintID)
	if err != nil {
		return nil, fmt.Errorf("get sprint tasks: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan task id: %w", err)
		}
		s.TaskIDs = append(s.TaskIDs, id)
	}
	return &s, nil
}

// GetActive returns the sprint with status "planning" or "running".
// Returns nil, nil if none exists. Returns error if multiple active sprints found.
func (p *Planner) GetActive() (*Sprint, error) {
	rows, err := p.db.Query(
		`SELECT id FROM sprints WHERE status IN ('planning', 'running')`,
	)
	if err != nil {
		return nil, fmt.Errorf("get active sprint: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan sprint id: %w", err)
		}
		ids = append(ids, id)
	}

	if len(ids) == 0 {
		return nil, nil
	}
	if len(ids) > 1 {
		return nil, fmt.Errorf("multiple active sprints found: %v", ids)
	}

	return p.Get(ids[0])
}

// ResetSprintTasks resets all tasks in a sprint back to pending with no sprint association.
func (p *Planner) ResetSprintTasks(sprintID string) error {
	_, err := p.db.Exec(
		`UPDATE tasks SET status = 'pending', sprint_id = NULL, updated_at = ? WHERE sprint_id = ?`,
		time.Now().UTC(), sprintID,
	)
	if err != nil {
		return fmt.Errorf("reset sprint tasks: %w", err)
	}
	return nil
}

// GetTask fetches a task by ID from the underlying task store.
func (p *Planner) GetTask(id string) (*task.Task, error) {
	return p.tasks.Get(id)
}

// CompleteTask marks a task as completed/review/failed.
func (p *Planner) CompleteTask(_ string, taskID, status string) error {
	if status != "completed" && status != "failed" && status != "review" {
		return fmt.Errorf("invalid task completion status: %s", status)
	}

	if err := p.tasks.Update(taskID, map[string]interface{}{
		"status": status,
	}); err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	p.emit("task.updated", taskID)
	return nil
}

// CompleteSprintIfDone completes or fails a sprint when all tasks are terminal.
func (p *Planner) CompleteSprintIfDone(sprintID string) error {
	var remaining int
	err := p.db.QueryRow(
		`SELECT COUNT(*) FROM tasks WHERE sprint_id = ? AND status NOT IN ('completed', 'merged', 'failed')`,
		sprintID,
	).Scan(&remaining)
	if err != nil {
		return fmt.Errorf("check remaining: %w", err)
	}
	if remaining > 0 {
		return nil
	}

	var failCount int
	if err := p.db.QueryRow(
		`SELECT COUNT(*) FROM tasks WHERE sprint_id = ? AND status = 'failed'`,
		sprintID,
	).Scan(&failCount); err != nil {
		return fmt.Errorf("check failed: %w", err)
	}

	if failCount > 0 {
		return p.Fail(sprintID)
	}
	return p.Complete(sprintID)
}

// RecoverOrphans finds tasks in "running" status and determines their state.
// Call this on startup before accepting new commands.
func (p *Planner) RecoverOrphans(worktreeDir, integrationBranch string) ([]OrphanedTask, error) {
	tasks, err := p.tasks.ListByStatus("running")
	if err != nil {
		return nil, err
	}

	var orphans []OrphanedTask
	for _, t := range tasks {
		wtPath := filepath.Join(worktreeDir, "task-"+t.ID)
		hasCommits := false

		// Check if worktree exists and has commits.
		if _, err := os.Stat(wtPath); err == nil {
			cmd := exec.Command("git", "log", integrationBranch+"..HEAD", "--oneline")
			cmd.Dir = wtPath
			out, _ := cmd.Output()
			hasCommits = len(strings.TrimSpace(string(out))) > 0
		}

		orphans = append(orphans, OrphanedTask{
			TaskID:       t.ID,
			SprintID:     t.SprintID,
			WorktreePath: wtPath,
			HasCommits:   hasCommits,
		})
	}
	return orphans, nil
}

// ResolveOrphan transitions an orphaned task to an appropriate state.
// - HasCommits=true -> move to "review" (work was done, needs review)
// - HasCommits=false -> move to "failed" (no work completed)
func (p *Planner) ResolveOrphan(taskID string, hasCommits bool) error {
	if hasCommits {
		return p.tasks.Update(taskID, map[string]interface{}{"status": "review"})
	}
	return p.tasks.Update(taskID, map[string]interface{}{"status": "failed"})
}

// RecoverSprint marks a "running" sprint as "failed" if it has no active processes.
func (p *Planner) RecoverSprint(sprintID string) error {
	return p.Fail(sprintID)
}
