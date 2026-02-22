package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/pty"
)

type createSessionRequest struct {
	Type    string   `json:"type"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Tool    string   `json:"tool"`
	TaskID  string   `json:"task_id"`
	Dir     string   `json:"working_dir"`
	Cols    uint16   `json:"cols"`
	Rows    uint16   `json:"rows"`
}

type sessionDTO struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Tool      string `json:"tool"`
	TaskID    string `json:"task_id"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
	CreatedAt string `json:"created_at"`
}

func (s *Server) routeSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleListSessions(w, r)
	case http.MethodPost:
		s.handleCreateSession(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) routeSessionByID(w http.ResponseWriter, r *http.Request) {
	id := extractPathParam(r.URL.Path, "/api/v1/sessions/")
	if id == "" {
		jsonError(w, "missing session id", http.StatusBadRequest)
		return
	}
	id = strings.SplitN(id, "/", 2)[0]
	if id == "" {
		jsonError(w, "missing session id", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodDelete:
		s.handleKillSession(w, r, id)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	if s.sessionMgr == nil {
		jsonError(w, "session manager unavailable", http.StatusServiceUnavailable)
		return
	}

	var req createSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	if req.Type == "" {
		req.Type = string(pty.SessionWorker)
	}
	if req.Type != string(pty.SessionOrchestrator) && req.Type != string(pty.SessionWorker) {
		jsonError(w, "invalid type (expected orchestrator or worker)", http.StatusBadRequest)
		return
	}

	if req.Command == "" {
		req.Command = os.Getenv("SHELL")
		if req.Command == "" {
			req.Command = "/bin/bash"
		}
	}
	if req.Dir == "" {
		req.Dir = s.repoDir
	}
	if req.Tool == "" {
		req.Tool = filepath.Base(req.Command)
	}

	sess, err := s.sessionMgr.Create(pty.CreateOpts{
		Type:    pty.SessionType(req.Type),
		Command: req.Command,
		Args:    req.Args,
		Dir:     req.Dir,
		Tool:    req.Tool,
		TaskID:  req.TaskID,
		Cols:    req.Cols,
		Rows:    req.Rows,
	})
	if err != nil {
		jsonError(w, err, http.StatusBadRequest)
		return
	}

	jsonResponse(w, http.StatusCreated, map[string]interface{}{
		"data": sessionDTO{
			ID:        sess.ID,
			Type:      string(sess.Type),
			Tool:      sess.Tool,
			TaskID:    sess.TaskID,
			Cols:      sess.Cols,
			Rows:      sess.Rows,
			CreatedAt: sess.CreatedAt.UTC().Format(time.RFC3339Nano),
		},
	})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	if s.sessionMgr == nil {
		jsonError(w, "session manager unavailable", http.StatusServiceUnavailable)
		return
	}

	sessions, err := s.sessionMgr.ListActive()
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].CreatedAt.Before(sessions[j].CreatedAt)
	})

	out := make([]sessionDTO, 0, len(sessions))
	for _, sess := range sessions {
		out = append(out, sessionDTO{
			ID:        sess.ID,
			Type:      string(sess.Type),
			Tool:      sess.Tool,
			TaskID:    sess.TaskID,
			Cols:      sess.Cols,
			Rows:      sess.Rows,
			CreatedAt: sess.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}

	jsonOK(w, map[string]interface{}{"sessions": out})
}

func (s *Server) handleStartOrchestrator(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.sessionMgr == nil {
		jsonError(w, "session manager unavailable", http.StatusServiceUnavailable)
		return
	}
	s.BootstrapOrchestrator()
	jsonOK(w, map[string]string{"status": "started"})
}

func (s *Server) handleKillSession(w http.ResponseWriter, r *http.Request, id string) {
	if s.sessionMgr == nil {
		jsonError(w, "session manager unavailable", http.StatusServiceUnavailable)
		return
	}

	if s.sessionMgr.Get(id) == nil {
		jsonError(w, "session not found", http.StatusNotFound)
		return
	}

	if err := s.sessionMgr.Kill(id); err != nil {
		jsonError(w, err, http.StatusBadRequest)
		return
	}
	jsonOK(w, map[string]string{"status": "killed"})
}
