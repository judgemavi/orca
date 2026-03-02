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
	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/logging"
	"github.com/jasjeetmavi/orca/internal/model"
	"github.com/jasjeetmavi/orca/internal/worktree"
)

func (s *Server) HandleExploreTool(_ json.RawMessage) (interface{}, error) {
	toolName, d, err := s.config.ResolveToolForPhase("explore", "")
	if err != nil {
		return nil, err
	}
	model := s.config.ResolveModelForPhase("explore", "", d)

	memStore, err := s.getMemoryStore()
	if err != nil {
		return nil, err
	}
	explorer := explore.New(toolName, d, model, 10*time.Minute, s.repoDir, interaction.NewStore(s.db, ".orca/interactions")).
		WithMemory(memStore).
		WithSyncer(s.newMemorySyncer(memStore))
	outPath, err := explorer.Run()
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"path": outPath}, nil
}

func (s *Server) HandleConfigGetTool(argsRaw json.RawMessage) (interface{}, error) {
	if _, err := parseArgs[struct{}](argsRaw); err != nil {
		return nil, fmt.Errorf("config_get: %w", err)
	}
	return s.config, nil
}

func (s *Server) HandleModelsListTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Tool string `json:"tool"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("models_list: %w", err)
	}
	if s.config == nil {
		return nil, fmt.Errorf("models listing not configured")
	}

	requestedTool := strings.TrimSpace(args.Tool)
	if requestedTool != "" {
		d, ok := driver.Get(requestedTool)
		if !ok {
			return nil, fmt.Errorf("tool %q not found", requestedTool)
		}
		return map[string][]model.Model{
			requestedTool: model.FromDriver(requestedTool, d),
		}, nil
	}

	return model.AllFromConfig(s.config), nil
}

func (s *Server) HandleConfigUpdateTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Patch json.RawMessage `json:"patch"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("config_update: %w", err)
	}
	if len(args.Patch) == 0 {
		return nil, fmt.Errorf("config_update: patch is required")
	}

	cfg, err := config.UpdateFromDB(s.db.DB, args.Patch)
	if err != nil {
		return nil, fmt.Errorf("config_update: %w", err)
	}
	s.config = cfg
	if s.onEvent != nil {
		s.onEvent("config.updated", cfg)
	}
	return cfg, nil
}

func (s *Server) HandleExploreStatusTool(_ json.RawMessage) (interface{}, error) {
	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("explore status: %w", err)
	}
	exists := false
	stale := false
	if health, err := store.BuildHealthSummary(); err == nil && health != nil {
		exists = health.TotalEntries > 0
		stale = health.StaleCount > 0
	}
	if status, err := s.newMemorySyncer(store).Status(); err == nil && status != nil {
		stale = stale || status.ContextStale
	}
	return map[string]interface{}{
		"exists":      exists,
		"stale":       stale,
		"age_minutes": 0,
	}, nil
}

func (s *Server) HandleWorktreeCleanupTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		DryRun      bool `json:"dry_run"`
		MaxAgeHours int  `json:"max_age_hours"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("worktree_cleanup: %w", err)
	}
	if s.config == nil {
		return nil, fmt.Errorf("worktree cleanup not configured")
	}

	maxAgeHours := args.MaxAgeHours
	if maxAgeHours <= 0 {
		maxAgeHours = 168
	}
	maxAge := time.Duration(maxAgeHours) * time.Hour
	wm := worktree.NewManager(s.repoDir, s.config.Project.WorktreeDir)

	if args.DryRun {
		list, err := wm.ListWithAge()
		if err != nil {
			return nil, fmt.Errorf("list worktrees: %w", err)
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
	if s.config == nil {
		return nil, fmt.Errorf("worktree status not configured")
	}
	wm := worktree.NewManager(s.repoDir, s.config.Project.WorktreeDir)

	listWithAge, err := wm.ListWithAge()
	if err != nil {
		return nil, fmt.Errorf("list worktrees: %w", err)
	}

	all, err := wm.List()
	if err != nil {
		return nil, fmt.Errorf("list all worktrees: %w", err)
	}
	branchesByPath := make(map[string]string, len(all))
	for _, wt := range all {
		branchesByPath[wt.Path] = wt.Branch
	}

	totalDiskBytes, err := wm.DiskUsage()
	if err != nil {
		return nil, fmt.Errorf("disk usage: %w", err)
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

func (s *Server) HandleCostStatusTool(argsRaw json.RawMessage) (interface{}, error) {
	if _, err := parseArgs[struct{}](argsRaw); err != nil {
		return nil, fmt.Errorf("cost_status: %w", err)
	}
	if s.db == nil {
		return nil, fmt.Errorf("cost tracking not configured")
	}

	tracker := interaction.NewStore(s.db, ".orca/interactions")
	total, err := tracker.ProjectTotal()
	if err != nil {
		return nil, fmt.Errorf("project total: %w", err)
	}
	tools, err := tracker.ProjectSummary()
	if err != nil {
		return nil, fmt.Errorf("project summary: %w", err)
	}
	return map[string]interface{}{
		"total_cost": total,
		"tools":      tools,
	}, nil
}

func (s *Server) HandleQualityResultsTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("quality_results: %w", err)
	}
	taskID := strings.TrimSpace(args.TaskID)
	if taskID == "" {
		return nil, fmt.Errorf("task_id is required")
	}
	if s.db == nil {
		return nil, fmt.Errorf("database not configured")
	}

	var qualityJSON sql.NullString
	err = s.db.QueryRow(
		`SELECT quality_json FROM task_interactions WHERE task_id = ? AND phase = 'run' ORDER BY started_at DESC LIMIT 1`,
		taskID,
	).Scan(&qualityJSON)
	if err == sql.ErrNoRows {
		return map[string]interface{}{"task_id": taskID, "quality": nil}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("query quality: %w", err)
	}

	if !qualityJSON.Valid || strings.TrimSpace(qualityJSON.String) == "" {
		return map[string]interface{}{"task_id": taskID, "quality": nil}, nil
	}
	if !json.Valid([]byte(qualityJSON.String)) {
		return nil, fmt.Errorf("invalid quality_json payload")
	}

	var quality interface{}
	if err := json.Unmarshal([]byte(qualityJSON.String), &quality); err != nil {
		return nil, fmt.Errorf("parse quality_json: %w", err)
	}
	return map[string]interface{}{
		"task_id": taskID,
		"quality": quality,
	}, nil
}

func (s *Server) HandleLogEventTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Level   string         `json:"level"`
		Message string         `json:"message"`
		TaskID  string         `json:"task_id"`
		Attrs   map[string]any `json:"attrs"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("log_event: %w", err)
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
	args, err := parseArgs[struct {
		Level   string `json:"level"`
		TaskID  string `json:"task_id"`
		Since   string `json:"since"`
		Limit   int    `json:"limit"`
		Pattern string `json:"pattern"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("log_query: %w", err)
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

	entries, err := logging.Query(resolveLogPath(s.repoDir, s.config), logging.Filter{
		Level:   strings.ToLower(strings.TrimSpace(args.Level)),
		TaskID:  strings.TrimSpace(args.TaskID),
		Since:   since,
		Pattern: strings.TrimSpace(args.Pattern),
		Limit:   args.Limit,
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
