package task

import (
	"fmt"
	"sort"
	"strings"
)

func (s *Store) AssociateFiles(taskID string, paths []string) error {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return fmt.Errorf("task id required")
	}
	normalized := normalizeTaskFilePaths(paths)
	if len(normalized) == 0 {
		return nil
	}
	for _, path := range normalized {
		if _, err := s.db.Exec(
			`INSERT OR IGNORE INTO task_file_associations (task_id, file_path) VALUES (?, ?)`,
			taskID,
			path,
		); err != nil {
			return fmt.Errorf("associate task file %q: %w", path, err)
		}
	}
	return nil
}

func (s *Store) GetFilePaths(taskID string) ([]string, error) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return []string{}, nil
	}
	rows, err := s.db.Query(
		`SELECT file_path FROM task_file_associations WHERE task_id = ? ORDER BY file_path`,
		taskID,
	)
	if err != nil {
		return nil, fmt.Errorf("get task file paths: %w", err)
	}
	defer rows.Close()
	paths := make([]string, 0)
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return paths, nil
}

func (s *Store) FindTasksByFilePaths(paths []string, excludeStatuses []string) ([]string, error) {
	filePaths := normalizeTaskFilePaths(paths)
	if len(filePaths) == 0 {
		return []string{}, nil
	}

	args := make([]interface{}, 0, len(filePaths)+len(excludeStatuses))
	query := strings.Builder{}
	query.WriteString(`SELECT DISTINCT tfa.task_id
		FROM task_file_associations tfa
		JOIN tasks t ON t.id = tfa.task_id
		WHERE tfa.file_path IN (`)
	query.WriteString(strings.TrimSuffix(strings.Repeat("?,", len(filePaths)), ","))
	query.WriteString(")")
	for _, path := range filePaths {
		args = append(args, path)
	}

	excluded := make([]string, 0, len(excludeStatuses))
	for _, status := range excludeStatuses {
		status = strings.TrimSpace(status)
		if status == "" {
			continue
		}
		excluded = append(excluded, status)
	}
	if len(excluded) > 0 {
		query.WriteString(" AND t.status NOT IN (")
		query.WriteString(strings.TrimSuffix(strings.Repeat("?,", len(excluded)), ","))
		query.WriteString(")")
		for _, status := range excluded {
			args = append(args, status)
		}
	}
	query.WriteString(" ORDER BY t.updated_at DESC")

	rows, err := s.db.Query(query.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("find tasks by file paths: %w", err)
	}
	defer rows.Close()

	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func normalizeTaskFilePaths(paths []string) []string {
	if len(paths) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(paths))
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		out = append(out, path)
	}
	if len(out) == 0 {
		return nil
	}
	sort.Strings(out)
	return out
}
