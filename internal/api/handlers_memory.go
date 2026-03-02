package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/jasjeetmavi/orca/internal/memory"
)

func (s *Server) handleListMemory(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if s.memoryStore == nil {
		jsonError(w, "memory store not configured", http.StatusInternalServerError)
		return
	}

	category := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("category")))
	tag := strings.TrimSpace(r.URL.Query().Get("tag"))
	sourceType := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("source_type")))
	filePath := strings.TrimSpace(r.URL.Query().Get("file_path"))
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	limitRaw := strings.TrimSpace(r.URL.Query().Get("limit"))

	if category != "" && !isValidMemoryCategory(category) {
		jsonError(w, "category must be one of: pattern|pitfall|preference|convention|architecture|dependency", http.StatusBadRequest)
		return
	}
	if sourceType != "" && !isValidMemorySourceType(sourceType) {
		jsonError(w, "source_type must be one of: retro|task|commit", http.StatusBadRequest)
		return
	}

	if query != "" {
		limit := 10
		if limitRaw != "" {
			parsed, err := strconv.Atoi(limitRaw)
			if err != nil || parsed <= 0 {
				jsonError(w, "limit must be a positive integer", http.StatusBadRequest)
				return
			}
			limit = parsed
		}

		entries, err := s.memoryStore.Search(query, limit)
		if err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return
		}

		filtered := make([]*memory.Entry, 0, len(entries))
		for _, entry := range entries {
			if category != "" && entry.Category != category {
				continue
			}
			if tag != "" && !hasMemoryTag(entry.Tags, tag) {
				continue
			}
			if sourceType != "" && strings.ToLower(strings.TrimSpace(entry.SourceType)) != sourceType {
				continue
			}
			if filePath != "" && !hasMemoryFilePath(entry.FilePaths, filePath) {
				continue
			}
			filtered = append(filtered, entry)
		}
		jsonOK(w, filtered)
		return
	}

	if limitRaw != "" {
		jsonError(w, "limit requires q", http.StatusBadRequest)
		return
	}

	entries, err := s.memoryStore.List(memory.ListOpts{
		Category:   category,
		Tag:        tag,
		SourceType: sourceType,
		FilePath:   filePath,
	})
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	jsonOK(w, entries)
}

func (s *Server) handleGetMemory(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if s.memoryStore == nil {
		jsonError(w, "memory store not configured", http.StatusInternalServerError)
		return
	}

	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		jsonError(w, "id required", http.StatusBadRequest)
		return
	}

	entry, err := s.memoryStore.Get(id)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}
	jsonOK(w, entry)
}

func (s *Server) handleUpdateMemory(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPatch) {
		return
	}
	if s.memoryStore == nil {
		jsonError(w, "memory store not configured", http.StatusInternalServerError)
		return
	}

	type updateMemoryReq struct {
		Content    *string  `json:"content"`
		Confidence *float64 `json:"confidence"`
		Category   *string  `json:"category"`
	}
	body, ok := decodeJSON[updateMemoryReq](w, r, false)
	if !ok {
		return
	}

	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		jsonError(w, "id required", http.StatusBadRequest)
		return
	}

	fields := map[string]interface{}{}
	if body.Content != nil {
		content := strings.TrimSpace(*body.Content)
		if content == "" {
			jsonError(w, "content cannot be empty", http.StatusBadRequest)
			return
		}
		fields["content"] = content
	}
	if body.Confidence != nil {
		if *body.Confidence < 0 || *body.Confidence > 1 {
			jsonError(w, "confidence must be between 0 and 1", http.StatusBadRequest)
			return
		}
		fields["confidence"] = *body.Confidence
	}
	if body.Category != nil {
		category := strings.TrimSpace(strings.ToLower(*body.Category))
		if !isValidMemoryCategory(category) {
			jsonError(w, "category must be one of: pattern|pitfall|preference|convention|architecture|dependency", http.StatusBadRequest)
			return
		}
		fields["category"] = category
	}
	if len(fields) == 0 {
		jsonError(w, "no fields to update", http.StatusBadRequest)
		return
	}

	if err := s.memoryStore.Update(id, fields); err != nil {
		if strings.Contains(err.Error(), "not found") {
			jsonError(w, err, http.StatusNotFound)
			return
		}
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	entry, err := s.memoryStore.Get(id)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	jsonOK(w, entry)
}

func (s *Server) handleDeleteMemory(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodDelete) {
		return
	}
	if s.memoryStore == nil {
		jsonError(w, "memory store not configured", http.StatusInternalServerError)
		return
	}

	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		jsonError(w, "id required", http.StatusBadRequest)
		return
	}

	if _, err := s.memoryStore.Get(id); err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}
	if err := s.memoryStore.Delete(id); err != nil {
		jsonError(w, err, http.StatusBadRequest)
		return
	}
	jsonOK(w, map[string]string{"deleted": id})
}

func (s *Server) handleSyncMemory(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if s.memoryStore == nil || s.db == nil {
		jsonError(w, "memory store not configured", http.StatusInternalServerError)
		return
	}
	syncer := s.newMemorySyncer(s.memoryStore)
	result, err := syncer.Sync()
	if err != nil {
		s.hub.Broadcast(Event{Type: "sync.failed", Data: map[string]string{"error": err.Error()}})
		s.hub.Broadcast(Event{Type: "memory.sync.failed", Data: map[string]string{"error": err.Error()}})
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	s.hub.Broadcast(Event{Type: "sync.completed", Data: result})
	s.hub.Broadcast(Event{Type: "memory.sync.completed", Data: result})
	jsonOK(w, result)
}

func hasMemoryTag(tags []string, needle string) bool {
	needle = strings.TrimSpace(strings.ToLower(needle))
	if needle == "" {
		return false
	}
	for _, tag := range tags {
		if strings.ToLower(strings.TrimSpace(tag)) == needle {
			return true
		}
	}
	return false
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
