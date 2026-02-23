package api

import "net/http"

// ========== Config (read-only) ==========

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, s.cfg)
}
