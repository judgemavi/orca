package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/ops"
)

// ========== Explore ==========

func (s *Server) handleExplore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var toolCfg config.ToolConfig
	for _, tc := range s.cfg.Tools {
		toolCfg = tc
		break
	}

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "explore",
		TargetID: "",
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonResponse(w, 202, map[string]interface{}{"data": map[string]string{"status": "exploring"}})

	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("explore panic: %v", rec)
				if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
					log.Printf("mark explore operation failed %s: %v", opID, opErr)
				}
				s.hub.Broadcast(Event{Type: "explore.failed", Data: map[string]string{"error": errMsg}})
			}
		}()

		explorer := explore.New(toolCfg, s.repoDir)
		outPath, err := explorer.Run()
		if err != nil {
			if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
				log.Printf("mark explore operation failed %s: %v", opID, opErr)
			}
			s.hub.Broadcast(Event{Type: "explore.failed", Data: map[string]string{"error": err.Error()}})
			return
		}
		resultBytes, _ := json.Marshal(map[string]string{"path": outPath})
		if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
			log.Printf("complete explore operation %s: %v", opID, err)
		}
		s.hub.Broadcast(Event{Type: "explore.completed", Data: map[string]string{"path": outPath}})
	}()
}

func (s *Server) handleGetContext(w http.ResponseWriter, r *http.Request) {
	content := explore.LoadContext(s.repoDir)
	jsonOK(w, map[string]string{"content": content})
}

func (s *Server) handlePutContext(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	outPath, err := explore.WriteManualContext(s.repoDir, req.Content)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	jsonOK(w, map[string]string{"path": outPath})
}
