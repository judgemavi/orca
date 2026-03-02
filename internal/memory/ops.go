// ops.go contains shared memory business operations used by CLI, API, and MCP surfaces.
package memory

import (
	"fmt"
	"strings"
)

type EntryDetail struct {
	Entry       *Entry       `json:"entry"`
	UsedByTasks []UsedByTask `json:"used_by_tasks,omitempty"`
	Supersedes  []string     `json:"supersedes,omitempty"`
}

type ListResult struct {
	Entries []*Entry `json:"entries"`
	Total   int      `json:"total"`
}

type QueryResult struct {
	Entries []EntryDetail `json:"entries"`
}

type SearchOpts struct {
	Query      string
	Limit      int
	Category   string
	Tag        string
	SourceType string
	FilePath   string
}

type UpdateEntryInput struct {
	Content    *string
	Confidence *float64
	Category   *string
}

type DeleteResult struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

func (s *Store) ListEntries(opts ListOpts) (*ListResult, error) {
	entries, err := s.List(opts)
	if err != nil {
		return nil, err
	}
	return &ListResult{
		Entries: entries,
		Total:   len(entries),
	}, nil
}

func (s *Store) GetEntryDetail(id string) (*EntryDetail, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, fmt.Errorf("id required")
	}

	entry, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	usedBy, err := s.FindUsedByTasks(entry.ID)
	if err != nil {
		return nil, err
	}
	supersedes, err := s.FindSupersededIDs(entry.ID)
	if err != nil {
		return nil, err
	}

	return &EntryDetail{
		Entry:       entry,
		UsedByTasks: usedBy,
		Supersedes:  supersedes,
	}, nil
}

func (s *Store) QueryEntries(query string, limit int) (*QueryResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return &QueryResult{Entries: []EntryDetail{}}, nil
	}
	if limit <= 0 {
		limit = 10
	}

	entries, err := s.Search(query, limit)
	if err != nil {
		return nil, err
	}

	result := &QueryResult{
		Entries: make([]EntryDetail, 0, len(entries)),
	}
	for _, entry := range entries {
		usedBy, err := s.FindUsedByTasks(entry.ID)
		if err != nil {
			return nil, err
		}
		result.Entries = append(result.Entries, EntryDetail{
			Entry:       entry,
			UsedByTasks: usedBy,
		})
	}
	return result, nil
}

func (s *Store) SearchEntries(opts SearchOpts) ([]*Entry, error) {
	query := strings.TrimSpace(opts.Query)
	if query == "" {
		return []*Entry{}, nil
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = 10
	}

	category := strings.TrimSpace(strings.ToLower(opts.Category))
	if category != "" && !IsValidCategory(category) {
		return nil, fmt.Errorf("category must be one of: %s", strings.Join(ValidCategories(), "|"))
	}
	sourceType := strings.TrimSpace(strings.ToLower(opts.SourceType))
	if sourceType != "" && !IsValidSourceType(sourceType) {
		return nil, fmt.Errorf("source_type must be one of: %s", strings.Join(ValidSourceTypes(), "|"))
	}
	tag := strings.TrimSpace(opts.Tag)
	filePath := strings.TrimSpace(opts.FilePath)

	entries, err := s.Search(query, limit)
	if err != nil {
		return nil, err
	}

	filtered := make([]*Entry, 0, len(entries))
	for _, entry := range entries {
		if category != "" && strings.ToLower(strings.TrimSpace(entry.Category)) != category {
			continue
		}
		if sourceType != "" && strings.ToLower(strings.TrimSpace(entry.SourceType)) != sourceType {
			continue
		}
		if tag != "" && !containsTag(entry.Tags, tag) {
			continue
		}
		if filePath != "" && !containsPath(entry.FilePaths, filePath) {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered, nil
}

func BuildUpdateFields(input UpdateEntryInput) (UpdateFields, bool, error) {
	fields := UpdateFields{}
	hasUpdates := false

	if input.Content != nil {
		content := strings.TrimSpace(*input.Content)
		if content == "" {
			return UpdateFields{}, false, fmt.Errorf("content cannot be empty")
		}
		fields.Content = Ptr(content)
		hasUpdates = true
	}
	if input.Confidence != nil {
		if *input.Confidence < 0 || *input.Confidence > 1 {
			return UpdateFields{}, false, fmt.Errorf("confidence must be between 0 and 1")
		}
		fields.Confidence = input.Confidence
		hasUpdates = true
	}
	if input.Category != nil {
		category := strings.TrimSpace(strings.ToLower(*input.Category))
		if !IsValidCategory(category) {
			return UpdateFields{}, false, fmt.Errorf("category must be one of: %s", strings.Join(ValidCategories(), "|"))
		}
		fields.Category = Ptr(category)
		hasUpdates = true
	}

	return fields, hasUpdates, nil
}

func (s *Store) UpdateEntry(id string, input UpdateEntryInput) (*Entry, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, fmt.Errorf("id required")
	}

	fields, hasUpdates, err := BuildUpdateFields(input)
	if err != nil {
		return nil, err
	}
	if !hasUpdates {
		return nil, fmt.Errorf("no fields to update")
	}
	if err := s.Update(id, fields); err != nil {
		return nil, err
	}
	return s.Get(id)
}

func (s *Store) DeleteEntry(id string) (*DeleteResult, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, fmt.Errorf("id required")
	}
	entry, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if err := s.Delete(entry.ID); err != nil {
		return nil, err
	}
	return &DeleteResult{
		ID:      entry.ID,
		Deleted: true,
	}, nil
}

func containsTag(tags []string, needle string) bool {
	needle = strings.TrimSpace(strings.ToLower(needle))
	if needle == "" {
		return false
	}
	for _, tag := range tags {
		if strings.TrimSpace(strings.ToLower(tag)) == needle {
			return true
		}
	}
	return false
}

func containsPath(paths []string, needle string) bool {
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
