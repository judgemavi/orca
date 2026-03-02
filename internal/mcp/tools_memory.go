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
	if category != "" && !isValidMemoryCategory(category) {
		return nil, fmt.Errorf("category must be one of: pattern|pitfall|preference|convention|architecture|dependency")
	}
	sourceType := strings.TrimSpace(strings.ToLower(args.SourceType))
	if sourceType != "" && !isValidMemorySourceType(sourceType) {
		return nil, fmt.Errorf("source_type must be one of: retro|task|commit")
	}

	entries, err := store.List(memory.ListOpts{
		Category:   category,
		Tag:        strings.TrimSpace(args.Tag),
		SourceType: sourceType,
		FilePath:   strings.TrimSpace(args.FilePath),
	})
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entries": entries}, nil
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

	entry, err := store.Get(strings.TrimSpace(args.ID))
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entry": entry}, nil
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
	sourceType := strings.TrimSpace(strings.ToLower(args.SourceType))
	if sourceType != "" && !isValidMemorySourceType(sourceType) {
		return nil, fmt.Errorf("source_type must be one of: retro|task|commit")
	}
	filePath := strings.TrimSpace(args.FilePath)

	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_search: %w", err)
	}

	entries, err := store.Search(query, limit)
	if err != nil {
		return nil, err
	}
	filtered := make([]*memory.Entry, 0, len(entries))
	for _, entry := range entries {
		if sourceType != "" && strings.ToLower(strings.TrimSpace(entry.SourceType)) != sourceType {
			continue
		}
		if filePath != "" && !hasMemoryFilePath(entry.FilePaths, filePath) {
			continue
		}
		filtered = append(filtered, entry)
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

	fields := map[string]interface{}{}
	if args.Content != nil {
		content := strings.TrimSpace(*args.Content)
		if content == "" {
			return nil, fmt.Errorf("content cannot be empty")
		}
		fields["content"] = content
	}
	if args.Confidence != nil {
		if *args.Confidence < 0 || *args.Confidence > 1 {
			return nil, fmt.Errorf("confidence must be between 0 and 1")
		}
		fields["confidence"] = *args.Confidence
	}
	if args.Category != nil {
		category := strings.TrimSpace(strings.ToLower(*args.Category))
		if !isValidMemoryCategory(category) {
			return nil, fmt.Errorf("category must be one of: pattern|pitfall|preference|convention|architecture|dependency")
		}
		fields["category"] = category
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("at least one field must be provided")
	}

	store, err := s.getMemoryStore()
	if err != nil {
		return nil, fmt.Errorf("memory_update: %w", err)
	}

	if err := store.Update(id, fields); err != nil {
		return nil, err
	}
	entry, err := store.Get(id)
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

	if err := store.Delete(id); err != nil {
		return nil, err
	}
	return map[string]interface{}{"id": id, "deleted": true}, nil
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
	return status, nil
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

func isValidMemoryCategory(category string) bool {
	switch strings.TrimSpace(strings.ToLower(category)) {
	case "pattern", "pitfall", "preference", "convention", "architecture", "dependency":
		return true
	default:
		return false
	}
}

func isValidMemorySourceType(sourceType string) bool {
	switch strings.TrimSpace(strings.ToLower(sourceType)) {
	case "retro", "task", "commit":
		return true
	default:
		return false
	}
}

func hasMemoryFilePath(paths []string, needle string) bool {
	needle = strings.TrimSpace(needle)
	if needle == "" {
		return false
	}
	for _, path := range paths {
		if strings.TrimSpace(path) == needle {
			return true
		}
	}
	return false
}
