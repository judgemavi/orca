package api

import (
	"io"
	"net/http"

	"github.com/jasjeetmavi/orca/internal/config"
)

// ========== Config ==========

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, s.cfg)
}

func (s *Server) handleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, err, http.StatusBadRequest)
		return
	}

	cfg, err := config.UpdateFromDB(s.db.DB, body)
	if err != nil {
		jsonError(w, err, http.StatusBadRequest)
		return
	}

	s.cfg = cfg
	s.hub.Broadcast(Event{Type: "config.updated", Data: cfg})
	jsonOK(w, cfg)
}
