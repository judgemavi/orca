package task

import (
	"fmt"
	"slices"
	"strings"
)

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

	nodes := make([]string, 0, len(graph))
	for id := range graph {
		nodes = append(nodes, id)
	}

	if cycle, ok := DetectCycle(nodes, func(taskID string) []string {
		return graph[taskID]
	}); ok {
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

// GetReady returns all planned tasks whose deps are all merged (or have no deps).
// Tasks with deps that are only "completed" but not yet merged are NOT ready —
// the dependent task needs the dep's code in the integration branch.
func (s *Store) GetReady() ([]*Task, error) {
	return s.queryTasks(
		`SELECT t.id, t.title, t.description, t.plan, t.session_id, t.parent_id, t.status, t.created_at, t.updated_at
		 FROM tasks t
		 WHERE t.status = 'planned'
		   AND NOT EXISTS (
		     SELECT 1 FROM task_deps d
		     JOIN tasks dep ON dep.id = d.depends_on
		     WHERE d.task_id = t.id AND dep.status != 'merged'
		   )
		 ORDER BY t.created_at`,
	)
}

func (s *Store) loadDepsForTasks(tasks []*Task) (map[string][]string, error) {
	depsByTask := make(map[string][]string, len(tasks))
	if len(tasks) == 0 {
		return depsByTask, nil
	}

	args := make([]interface{}, 0, len(tasks))
	for _, t := range tasks {
		args = append(args, t.ID)
		depsByTask[t.ID] = nil
	}

	placeholders := strings.TrimRight(strings.Repeat("?,", len(tasks)), ",")
	query := fmt.Sprintf(`SELECT task_id, depends_on FROM task_deps WHERE task_id IN (%s)`, placeholders)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("load deps for tasks: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var taskID, dep string
		if err := rows.Scan(&taskID, &dep); err != nil {
			return nil, fmt.Errorf("scan dep: %w", err)
		}
		depsByTask[taskID] = append(depsByTask[taskID], dep)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate deps: %w", err)
	}

	return depsByTask, nil
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
