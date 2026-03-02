package api

import (
	"net/http"
	"time"

	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
)

// ========== Explore ==========

func (s *Server) handleExplore(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	hasTrackedCode, err := explore.HasTrackedCode(s.repoDir)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	if !hasTrackedCode {
		jsonOK(w, map[string]string{
			"status":  "skipped",
			"message": explore.NoTrackedCodeMessage,
		})
		return
	}

	toolName, d, err := s.cfg.ResolveToolForPhase(interaction.PhaseExplore, "")
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	model := s.cfg.ResolveModelForPhase(interaction.PhaseExplore, "", d)

	s.runAsyncHandler(w, interaction.PhaseExplore, map[string]string{"status": "exploring"}, func() {
		memoryStore := s.memoryStore
		if memoryStore == nil && s.db != nil {
			memoryStore = memory.NewStore(s.db)
		}
		explorer := explore.New(toolName, d, model, 10*time.Minute, s.repoDir, s.interactions).
			WithMemory(memoryStore).
			WithSyncer(memory.NewSyncer(memoryStore, s.db.DB, s.repoDir))
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
	jsonOK(w, content)
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
	jsonOK(w, outPath)
}
