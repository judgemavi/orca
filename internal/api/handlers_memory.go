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
	staleRaw := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("stale")))
	coveredBefore := strings.TrimSpace(r.URL.Query().Get("covered_before"))
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	limitRaw := strings.TrimSpace(r.URL.Query().Get("limit"))
	staleOnly := staleRaw == "1" || staleRaw == "true" || staleRaw == "yes"

	if category != "" && !memory.IsValidCategory(category) {
		jsonError(w, "category must be one of: pattern|pitfall|preference|convention|architecture|dependency", http.StatusBadRequest)
		return
	}
	if sourceType != "" && !memory.IsValidSourceType(sourceType) {
		jsonError(w, "source_type must be one of: retro|explore", http.StatusBadRequest)
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

		entries, err := s.memoryStore.SearchEntries(memory.SearchOpts{
			Query:      query,
			Limit:      limit,
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
		return
	}

	if limitRaw != "" {
		jsonError(w, "limit requires q", http.StatusBadRequest)
		return
	}

	result, err := s.memoryStore.ListEntries(memory.ListOpts{
		Category:      category,
		Tag:           tag,
		SourceType:    sourceType,
		FilePath:      filePath,
		StaleOnly:     staleOnly,
		CoveredBefore: coveredBefore,
	})
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	jsonOK(w, result.Entries)
}

func (s *Server) handleQueryMemory(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if s.memoryStore == nil {
		jsonError(w, "memory store not configured", http.StatusInternalServerError)
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		jsonError(w, "q is required", http.StatusBadRequest)
		return
	}
	limit := 10
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			jsonError(w, "limit must be a positive integer", http.StatusBadRequest)
			return
		}
		limit = parsed
	}

	result, err := s.memoryStore.QueryEntries(query, limit)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	jsonOK(w, result.Entries)
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

	detail, err := s.memoryStore.GetEntryDetail(id)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}
	jsonOK(w, detail)
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

	if body.Content == nil && body.Confidence == nil && body.Category == nil {
		jsonError(w, "no fields to update", http.StatusBadRequest)
		return
	}

	entry, err := s.memoryStore.UpdateEntry(id, memory.UpdateEntryInput{
		Content:    body.Content,
		Confidence: body.Confidence,
		Category:   body.Category,
	})
	if err != nil {
		if strings.Contains(err.Error(), "cannot be empty") ||
			strings.Contains(err.Error(), "must be between 0 and 1") ||
			strings.Contains(err.Error(), "category must be one of") ||
			strings.Contains(err.Error(), "id required") ||
			strings.Contains(err.Error(), "no fields to update") {
			jsonError(w, err, http.StatusBadRequest)
			return
		}
		if strings.Contains(err.Error(), "not found") {
			jsonError(w, err, http.StatusNotFound)
			return
		}
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

	result, err := s.memoryStore.DeleteEntry(id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			jsonError(w, err, http.StatusNotFound)
			return
		}
		jsonError(w, err, http.StatusBadRequest)
		return
	}
	jsonOK(w, result)
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

func (s *Server) handleRefreshMemory(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if s.memoryStore == nil || s.db == nil {
		jsonError(w, "memory store not configured", http.StatusInternalServerError)
		return
	}

	type refreshReq struct {
		EntryID string `json:"entry_id"`
	}
	body, ok := decodeJSON[refreshReq](w, r, true)
	if !ok {
		return
	}

	syncer := s.newMemorySyncer(s.memoryStore)
	result, err := syncer.Refresh(strings.TrimSpace(body.EntryID))
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	jsonOK(w, result)
}
