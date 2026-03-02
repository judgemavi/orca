package api

import (
	"net/http"
)

// ========== Costs ==========

func (s *Server) handleCosts(w http.ResponseWriter, r *http.Request) {
	runID := r.URL.Query().Get("run_id")

	if runID != "" {
		total, _ := s.interactions.RunTotal(runID)
		summary, _ := s.interactions.RunSummary(runID)
		jsonOK(w, map[string]interface{}{
			"run_id": runID,
			"total":  total,
			"tools":  summary,
		})
		return
	}

	projectTotal, _ := s.interactions.ProjectTotal()
	summary, _ := s.interactions.ProjectSummary()

	jsonOK(w, map[string]interface{}{
		"total": projectTotal,
		"tools": summary,
	})
}
