package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/jasjeetmavi/orca/internal/explore"
)

// ========== Explore ==========

func (s *Server) handleExplore(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	_, toolCfg, err := s.cfg.ResolvePhaseToolConfig("explore")
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	opID := ""
	opID = s.startAsyncOp(
		w,
		"explore",
		"",
		"explore",
		nil,
		map[string]string{"status": "exploring"},
		func() {
			explorer := explore.New(toolCfg, s.repoDir)
			outPath, err := explorer.Run()
			if err != nil {
				if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
					slog.Error("mark explore operation failed", "operation_id", opID, "err", opErr)
				}
				s.hub.Broadcast(Event{Type: "explore.failed", Data: map[string]string{"error": err.Error()}})
				return
			}
			resultBytes, _ := json.Marshal(map[string]string{"path": outPath})
			if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
				slog.Debug("complete explore operation failed", "operation_id", opID, "err", err)
			}
			s.hub.Broadcast(Event{Type: "explore.completed", Data: map[string]string{"path": outPath}})
		},
	)
	if opID == "" {
		return
	}
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
