package api

import (
	"net/http"
	"time"

	"github.com/jasjeetmavi/orca/internal/explore"
)

// ========== Explore ==========

func (s *Server) handleExplore(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	toolName, d, err := s.cfg.ResolveToolForPhase("explore", "")
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	model := s.cfg.ResolveModelForPhase("explore", "", d)

	s.runAsyncHandler(w, "explore", map[string]string{"status": "exploring"}, func() {
		explorer := explore.New(toolName, d, model, 10*time.Minute, s.repoDir, s.interactions)
		outPath, err := explorer.Run()
		if err != nil {
			s.hub.Broadcast(Event{Type: "explore.failed", Data: map[string]string{"error": err.Error()}})
			return
		}
		s.hub.Broadcast(Event{Type: "explore.completed", Data: map[string]string{"path": outPath}})
	})
}

func (s *Server) handleGetContext(w http.ResponseWriter, r *http.Request) {
	content := explore.LoadContext(s.repoDir)
	jsonOK(w, map[string]string{"content": content})
}

func (s *Server) handlePutContext(w http.ResponseWriter, r *http.Request) {
	type contextReq struct {
		Content string `json:"content"`
	}
	req, ok := decodeJSON[contextReq](w, r, false)
	if !ok {
		return
	}

	outPath, err := explore.WriteManualContext(s.repoDir, req.Content)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"path": outPath})
}
