package mcp

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/knowledge"
)

func (s *Server) HandleKnowledgeListTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Category string `json:"category"`
		Tag      string `json:"tag"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("knowledge_list: %w", err)
	}
	store, err := s.getKnowledgeStore()
	if err != nil {
		return nil, fmt.Errorf("knowledge_list: %w", err)
	}

	category := strings.TrimSpace(strings.ToLower(args.Category))
	if category != "" && !isValidKnowledgeCategory(category) {
		return nil, fmt.Errorf("category must be one of: pattern|pitfall|preference|convention")
	}

	entries, err := store.List(knowledge.ListOpts{Category: category, Tag: strings.TrimSpace(args.Tag)})
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entries": entries}, nil
}

func (s *Server) HandleKnowledgeGetTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		ID string `json:"id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("knowledge_get: %w", err)
	}
	if strings.TrimSpace(args.ID) == "" {
		return nil, fmt.Errorf("id is required")
	}
	store, err := s.getKnowledgeStore()
	if err != nil {
		return nil, fmt.Errorf("knowledge_get: %w", err)
	}

	entry, err := store.Get(strings.TrimSpace(args.ID))
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entry": entry}, nil
}

func (s *Server) HandleKnowledgeSearchTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("knowledge_search: %w", err)
	}
	query := strings.TrimSpace(args.Query)
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}

	limit := args.Limit
	if limit <= 0 {
		limit = 10
	}

	store, err := s.getKnowledgeStore()
	if err != nil {
		return nil, fmt.Errorf("knowledge_search: %w", err)
	}

	entries, err := store.Search(query, limit)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entries": entries}, nil
}

func (s *Server) HandleKnowledgeUpdateTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		ID         string   `json:"id"`
		Content    *string  `json:"content"`
		Confidence *float64 `json:"confidence"`
		Category   *string  `json:"category"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("knowledge_update: %w", err)
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
		if !isValidKnowledgeCategory(category) {
			return nil, fmt.Errorf("category must be one of: pattern|pitfall|preference|convention")
		}
		fields["category"] = category
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("at least one field must be provided")
	}

	store, err := s.getKnowledgeStore()
	if err != nil {
		return nil, fmt.Errorf("knowledge_update: %w", err)
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

func (s *Server) HandleKnowledgeDeleteTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		ID string `json:"id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("knowledge_delete: %w", err)
	}
	id := strings.TrimSpace(args.ID)
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}

	store, err := s.getKnowledgeStore()
	if err != nil {
		return nil, fmt.Errorf("knowledge_delete: %w", err)
	}

	if err := store.Delete(id); err != nil {
		return nil, err
	}
	return map[string]interface{}{"id": id, "deleted": true}, nil
}

func (s *Server) getKnowledgeStore() (*knowledge.Store, error) {
	if s.knowledgeStore != nil {
		return s.knowledgeStore, nil
	}
	if s.db == nil {
		return nil, fmt.Errorf("knowledge store not configured")
	}
	s.knowledgeStore = knowledge.NewStore(s.db)
	return s.knowledgeStore, nil
}

func isValidKnowledgeCategory(category string) bool {
	switch strings.TrimSpace(strings.ToLower(category)) {
	case "pattern", "pitfall", "preference", "convention":
		return true
	default:
		return false
	}
}
