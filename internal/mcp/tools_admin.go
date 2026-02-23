package mcp

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/cost"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/logging"
	"github.com/jasjeetmavi/orca/internal/worktree"
)

func (s *Server) HandleExploreTool(_ json.RawMessage) (interface{}, error) {
	_, toolCfg, err := s.cfg.ResolvePhaseToolConfig("explore")
	if err != nil {
		return nil, err
	}

	explorer := explore.New(toolCfg, s.repoDir)
	outPath, err := explorer.Run()
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"path": outPath}, nil
}

func (s *Server) HandleExploreStatusTool(_ json.RawMessage) (interface{}, error) {
	exists := explore.LoadContext(s.repoDir) != ""
	stale, err := explore.IsStale(s.repoDir)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}, nil
	}
	ageMinutes := int(explore.ContextAge(s.repoDir) / time.Minute)
	if ageMinutes < 0 {
		ageMinutes = 0
	}
	return map[string]interface{}{
		"exists":      exists,
		"stale":       stale,
		"age_minutes": ageMinutes,
	}, nil
}

func (s *Server) HandleWorktreeCleanupTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		DryRun      bool `json:"dry_run"`
		MaxAgeHours int  `json:"max_age_hours"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("worktree_cleanup args: %v", err)}, nil
	}
	if s.cfg == nil {
		return map[string]interface{}{"error": "worktree cleanup not configured"}, nil
	}

	maxAgeHours := args.MaxAgeHours
	if maxAgeHours <= 0 {
		maxAgeHours = 168
	}
	maxAge := time.Duration(maxAgeHours) * time.Hour
	wm := worktree.NewManager(s.repoDir, s.cfg.Project.WorktreeDir)

	if args.DryRun {
		list, err := wm.ListWithAge()
		if err != nil {
			return map[string]interface{}{
				"removed": []string{},
				"errors":  []string{err.Error()},
			}, nil
		}
		removed := make([]string, 0, len(list))
		for _, wt := range list {
			if wt.Age >= maxAge {
				removed = append(removed, wt.TaskID)
			}
		}
		return map[string]interface{}{
			"removed": removed,
			"errors":  []string{},
		}, nil
	}

	removed, errs := wm.CleanupStale(maxAge)
	errTexts := make([]string, 0, len(errs))
	for _, err := range errs {
		errTexts = append(errTexts, err.Error())
	}
	return map[string]interface{}{
		"removed": removed,
		"errors":  errTexts,
	}, nil
}

func (s *Server) HandleWorktreeStatusTool(_ json.RawMessage) (interface{}, error) {
	if s.cfg == nil {
		return map[string]interface{}{"error": "worktree status not configured"}, nil
	}
	wm := worktree.NewManager(s.repoDir, s.cfg.Project.WorktreeDir)

	listWithAge, err := wm.ListWithAge()
	if err != nil {
		return map[string]interface{}{"error": err.Error()}, nil
	}

	all, err := wm.List()
	if err != nil {
		return map[string]interface{}{"error": err.Error()}, nil
	}
	branchesByPath := make(map[string]string, len(all))
	for _, wt := range all {
		branchesByPath[wt.Path] = wt.Branch
	}

	totalDiskBytes, err := wm.DiskUsage()
	if err != nil {
		return map[string]interface{}{"error": err.Error()}, nil
	}

	worktrees := make([]map[string]interface{}, 0, len(listWithAge))
	for _, wt := range listWithAge {
		worktrees = append(worktrees, map[string]interface{}{
			"task_id":   wt.TaskID,
			"age_hours": int(wt.Age / time.Hour),
			"branch":    branchesByPath[wt.Path],
		})
	}
	return map[string]interface{}{
		"worktrees":        worktrees,
		"total_disk_bytes": totalDiskBytes,
	}, nil
}

func (s *Server) HandleBudgetStatusTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		SprintID string `json:"sprint_id"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("budget_status args: %v", err)}, nil
	}
	if s.planner == nil || s.planner.DB() == nil {
		return map[string]interface{}{"error": "cost tracking not configured"}, nil
	}

	tracker := cost.NewTracker(s.planner.DB())
	budget := s.cfg.Orchestrator.CostBudget
	if strings.TrimSpace(args.SprintID) != "" {
		total, err := tracker.SprintTotal(args.SprintID)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}
		tools, err := tracker.SprintSummary(args.SprintID)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}
		return map[string]interface{}{
			"sprint_id":  args.SprintID,
			"total_cost": total,
			"budget":     budget,
			"remaining":  budget - total,
			"tools":      tools,
		}, nil
	}

	total, err := tracker.ProjectTotal()
	if err != nil {
		return map[string]interface{}{"error": err.Error()}, nil
	}
	remaining, err := tracker.BudgetRemaining(budget)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}, nil
	}
	tools, err := tracker.ProjectSummary()
	if err != nil {
		return map[string]interface{}{"error": err.Error()}, nil
	}
	return map[string]interface{}{
		"total_cost": total,
		"budget":     budget,
		"remaining":  remaining,
		"tools":      tools,
	}, nil
}

func (s *Server) HandleQualityResultsTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID string `json:"task_id"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("quality_results args: %v", err)}, nil
	}
	taskID := strings.TrimSpace(args.TaskID)
	if taskID == "" {
		return map[string]interface{}{"error": "task_id is required"}, nil
	}
	if s.planner == nil || s.planner.DB() == nil {
		return map[string]interface{}{"error": "database not configured"}, nil
	}

	var qualityJSON sql.NullString
	err := s.planner.DB().QueryRow(
		`SELECT quality_json FROM artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
		taskID,
	).Scan(&qualityJSON)
	if err == sql.ErrNoRows {
		return map[string]interface{}{"task_id": taskID, "quality": nil}, nil
	}
	if err != nil {
		return map[string]interface{}{"error": err.Error()}, nil
	}

	if !qualityJSON.Valid || strings.TrimSpace(qualityJSON.String) == "" {
		return map[string]interface{}{"task_id": taskID, "quality": nil}, nil
	}
	if !json.Valid([]byte(qualityJSON.String)) {
		return map[string]interface{}{"error": "invalid quality_json payload"}, nil
	}

	var quality interface{}
	if err := json.Unmarshal([]byte(qualityJSON.String), &quality); err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("parse quality_json: %v", err)}, nil
	}
	return map[string]interface{}{
		"task_id": taskID,
		"quality": quality,
	}, nil
}

func (s *Server) HandleLogEventTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		Level    string         `json:"level"`
		Message  string         `json:"message"`
		TaskID   string         `json:"task_id"`
		SprintID string         `json:"sprint_id"`
		Attrs    map[string]any `json:"attrs"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("log_event args: %w", err)
	}

	level, err := parseSlogLevel(args.Level)
	if err != nil {
		return nil, fmt.Errorf("log_event level: %w", err)
	}
	msg := strings.TrimSpace(args.Message)
	if msg == "" {
		return nil, fmt.Errorf("message is required")
	}

	kv := make([]any, 0, 2+len(args.Attrs)*2)
	if taskID := strings.TrimSpace(args.TaskID); taskID != "" {
		kv = append(kv, "task_id", taskID)
	}
	if sprintID := strings.TrimSpace(args.SprintID); sprintID != "" {
		kv = append(kv, "sprint_id", sprintID)
	}
	if len(args.Attrs) > 0 {
		keys := make([]string, 0, len(args.Attrs))
		for key := range args.Attrs {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			kv = append(kv, key, args.Attrs[key])
		}
	}

	slog.Log(context.Background(), level, msg, kv...)
	return map[string]interface{}{"logged": true}, nil
}

func (s *Server) HandleLogQueryTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		Level    string `json:"level"`
		TaskID   string `json:"task_id"`
		SprintID string `json:"sprint_id"`
		Since    string `json:"since"`
		Limit    int    `json:"limit"`
		Pattern  string `json:"pattern"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("log_query args: %w", err)
	}
	if strings.TrimSpace(args.Level) != "" {
		if _, err := parseSlogLevel(args.Level); err != nil {
			return nil, fmt.Errorf("log_query level: %w", err)
		}
	}
	if args.Limit < 0 {
		return nil, fmt.Errorf("limit must be >= 0")
	}

	since, err := parseLogQuerySince(args.Since)
	if err != nil {
		return nil, fmt.Errorf("log_query since: %w", err)
	}

	entries, err := logging.Query(resolveLogPath(s.repoDir, s.cfg), logging.Filter{
		Level:    strings.ToLower(strings.TrimSpace(args.Level)),
		TaskID:   strings.TrimSpace(args.TaskID),
		SprintID: strings.TrimSpace(args.SprintID),
		Since:    since,
		Pattern:  strings.TrimSpace(args.Pattern),
		Limit:    args.Limit,
	})
	if err != nil {
		return nil, fmt.Errorf("query logs: %w", err)
	}
	return entries, nil
}

func parseSlogLevel(raw string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("invalid level %q (must be one of: debug|info|warn|error)", raw)
	}
}

func parseLogQuerySince(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	if d, err := time.ParseDuration(raw); err == nil {
		if d < 0 {
			return time.Time{}, fmt.Errorf("duration must be >= 0")
		}
		return time.Now().Add(-d), nil
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("must be RFC3339 timestamp or duration")
	}
	return t, nil
}

func resolveLogPath(repoDir string, cfg *config.Config) string {
	logPath := strings.TrimSpace(logging.DefaultConfig().File)
	if cfg != nil && strings.TrimSpace(cfg.Logging.File) != "" {
		logPath = strings.TrimSpace(cfg.Logging.File)
	}
	if filepath.IsAbs(logPath) || strings.TrimSpace(repoDir) == "" {
		return logPath
	}
	return filepath.Join(repoDir, logPath)
}
