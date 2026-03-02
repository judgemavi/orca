package mcp

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/memory"
)

func (s *Server) HandleMemoryListTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Category   string `json:"category"`
		Tag        string `json:"tag"`
		SourceType string `json:"source_type"`
		FilePath   string `json:"file_path"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("memory_list: %w", err)
	}
	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_list: %w", err)
	}

	category := strings.TrimSpace(strings.ToLower(args.Category))
	if category != "" && !memory.IsValidCategory(category) {
		return nil, fmt.Errorf("category must be one of: pattern|pitfall|preference|convention|architecture|dependency")
	}
	sourceType := strings.TrimSpace(strings.ToLower(args.SourceType))
	if sourceType != "" && !memory.IsValidSourceType(sourceType) {
		return nil, fmt.Errorf("source_type must be one of: retro|explore")
	}

	result, err := store.ListEntries(memory.ListOpts{
		Category:   category,
		Tag:        strings.TrimSpace(args.Tag),
		SourceType: sourceType,
		FilePath:   strings.TrimSpace(args.FilePath),
	})
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entries": result.Entries}, nil
}

func (s *Server) HandleMemoryGetTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		ID string `json:"id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("memory_get: %w", err)
	}
	if strings.TrimSpace(args.ID) == "" {
		return nil, fmt.Errorf("id is required")
	}
	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_get: %w", err)
	}

	detail, err := store.GetEntryDetail(strings.TrimSpace(args.ID))
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"entry":         detail.Entry,
		"used_by_tasks": detail.UsedByTasks,
		"supersedes":    detail.Supersedes,
	}, nil
}

func (s *Server) HandleMemorySearchTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Query      string `json:"query"`
		Limit      int    `json:"limit"`
		SourceType string `json:"source_type"`
		FilePath   string `json:"file_path"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("memory_search: %w", err)
	}
	query := strings.TrimSpace(args.Query)
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}

	limit := args.Limit
	if limit <= 0 {
		limit = 10
	}

	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_search: %w", err)
	}

	filtered, err := store.SearchEntries(memory.SearchOpts{
		Query:      query,
		Limit:      limit,
		SourceType: args.SourceType,
		FilePath:   args.FilePath,
	})
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entries": filtered}, nil
}

func (s *Server) HandleMemoryUpdateTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		ID         string   `json:"id"`
		Content    *string  `json:"content"`
		Confidence *float64 `json:"confidence"`
		Category   *string  `json:"category"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("memory_update: %w", err)
	}
	id := strings.TrimSpace(args.ID)
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}

	if args.Content == nil && args.Confidence == nil && args.Category == nil {
		return nil, fmt.Errorf("at least one field must be provided")
	}

	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_update: %w", err)
	}

	entry, err := store.UpdateEntry(id, memory.UpdateEntryInput{
		Content:    args.Content,
		Confidence: args.Confidence,
		Category:   args.Category,
	})
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entry": entry}, nil
}

func (s *Server) HandleMemoryDeleteTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		ID string `json:"id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("memory_delete: %w", err)
	}
	id := strings.TrimSpace(args.ID)
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}

	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_delete: %w", err)
	}

	result, err := store.DeleteEntry(id)
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Server) HandleMemorySyncTool(argsRaw json.RawMessage) (interface{}, error) {
	if _, err := parseArgs[struct{}](argsRaw); err != nil {
		return nil, fmt.Errorf("memory_sync: %w", err)
	}
	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_sync: %w", err)
	}
	if s.db == nil {
		return nil, fmt.Errorf("memory_sync: db not configured")
	}
	syncer := s.newMemorySyncer(store)
	result, err := syncer.Sync()
	if err != nil {
		return nil, fmt.Errorf("memory_sync: %w", err)
	}
	return result, nil
}

func (s *Server) HandleMemoryStatusTool(argsRaw json.RawMessage) (interface{}, error) {
	if _, err := parseArgs[struct{}](argsRaw); err != nil {
		return nil, fmt.Errorf("memory_status: %w", err)
	}
	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_status: %w", err)
	}
	syncer := s.newMemorySyncer(store)
	status, err := syncer.Status()
	if err != nil {
		return nil, fmt.Errorf("memory_status: %w", err)
	}
	health, err := store.BuildHealthSummary()
	if err != nil {
		return nil, fmt.Errorf("memory_status: %w", err)
	}

	return map[string]interface{}{
		"total_entries":      health.TotalEntries,
		"by_source":          health.BySource,
		"stale_count":        health.StaleCount,
		"avg_confidence":     health.AverageQuality,
		"last_synced_commit": status.LastSyncedCommit,
		"current_commit":     status.CurrentCommit,
		"sync_needed":        status.SyncNeeded,
		"commits_behind":     status.CommitsBehind,
		"context_stale":      status.ContextStale,
	}, nil
}

func (s *Server) HandleMemoryQueryTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("memory_query: %w", err)
	}
	query := strings.TrimSpace(args.Query)
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}
	limit := args.Limit
	if limit <= 0 {
		limit = 10
	}

	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_query: %w", err)
	}
	result, err := store.QueryEntries(query, limit)
	if err != nil {
		return nil, err
	}

	enriched := make([]map[string]interface{}, 0, len(result.Entries))
	for _, detail := range result.Entries {
		entry := detail.Entry
		enriched = append(enriched, map[string]interface{}{
			"id":                entry.ID,
			"content":           entry.Content,
			"category":          entry.Category,
			"tags":              entry.Tags,
			"source_type":       entry.SourceType,
			"confidence":        entry.Confidence,
			"file_paths":        entry.FilePaths,
			"stale":             entry.Stale,
			"covered_at_commit": entry.CoveredAtCommit,
			"source_task_id":    entry.SourceTaskID,
			"used_by_tasks":     detail.UsedByTasks,
		})
	}
	return map[string]interface{}{"entries": enriched}, nil
}

func (s *Server) HandleMemoryRefreshTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		EntryID string `json:"entry_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("memory_refresh: %w", err)
	}

	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_refresh: %w", err)
	}
	if s.db == nil {
		return nil, fmt.Errorf("memory_refresh: db not configured")
	}
	syncer := s.newMemorySyncer(store)
	result, err := syncer.Refresh(strings.TrimSpace(args.EntryID))
	if err != nil {
		return nil, fmt.Errorf("memory_refresh: %w", err)
	}
	return result, nil
}

func (s *Server) getMemoryStore() (*memory.Store, error) {
	if s.memoryStore != nil {
		return s.memoryStore, nil
	}
	if s.db == nil {
		return nil, fmt.Errorf("memory store not configured")
	}
	s.memoryStore = memory.NewStore(s.db)
	return s.memoryStore, nil
}
