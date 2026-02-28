package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/breakdown"
	"github.com/jasjeetmavi/orca/internal/interaction"
)

// ========== Plan (Breakdown) ==========

type breakdownOperationResult struct {
	TaskID         string                   `json:"task_id,omitempty"`
	Goal           string                   `json:"goal,omitempty"`
	SessionID      string                   `json:"session_id,omitempty"`
	Proposed       []breakdown.ProposedTask `json:"proposed,omitempty"`
	Accepted       bool                     `json:"accepted,omitempty"`
	Rejected       bool                     `json:"rejected,omitempty"`
	CreatedTaskIDs []string                 `json:"created_task_ids,omitempty"`
}

func parseBreakdownOperationResult(raw string) (breakdownOperationResult, error) {
	if strings.TrimSpace(raw) == "" {
		return breakdownOperationResult{}, nil
	}
	var out breakdownOperationResult
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return breakdownOperationResult{}, err
	}
	return out, nil
}

func (s *Server) findPendingBreakdownOperation(sessionID string) (*string, breakdownOperationResult, error) {
	rows, err := s.db.Query(
		`SELECT id, quality_json
		 FROM task_interactions
		 WHERE phase = 'breakdown' AND status = 'completed' AND run_id = ?
		 ORDER BY started_at DESC`,
		sessionID,
	)
	if err != nil {
		return nil, breakdownOperationResult{}, fmt.Errorf("list breakdown interactions: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id      string
			quality sql.NullString
		)
		if err := rows.Scan(&id, &quality); err != nil {
			return nil, breakdownOperationResult{}, fmt.Errorf("scan breakdown interaction: %w", err)
		}
		result, err := parseBreakdownOperationResult(quality.String)
		if err != nil {
			continue
		}
		if result.Accepted || result.Rejected || len(result.Proposed) == 0 {
			continue
		}
		return &id, result, nil
	}
	if err := rows.Err(); err != nil {
		return nil, breakdownOperationResult{}, fmt.Errorf("read breakdown interactions: %w", err)
	}
	return nil, breakdownOperationResult{}, sql.ErrNoRows
}

func (s *Server) resolveBreakdownOp(w http.ResponseWriter, opID, sessionID string) (string, breakdownOperationResult, bool) {
	trimmedOpID := strings.TrimSpace(opID)
	trimmedSessionID := strings.TrimSpace(sessionID)
	if trimmedSessionID == "" {
		trimmedSessionID = "default"
	}

	if trimmedOpID == "" {
		resolvedID, result, err := s.findPendingBreakdownOperation(trimmedSessionID)
		if err == sql.ErrNoRows {
			jsonError(w, "no pending plan for session", http.StatusNotFound)
			return "", breakdownOperationResult{}, false
		}
		if err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return "", breakdownOperationResult{}, false
		}
		return *resolvedID, result, true
	}

	op, err := s.interactions.Get(trimmedOpID)
	if err != nil {
		jsonError(w, "breakdown operation not found", http.StatusNotFound)
		return "", breakdownOperationResult{}, false
	}
	if op.Phase != "breakdown" {
		jsonError(w, "operation is not breakdown", http.StatusBadRequest)
		return "", breakdownOperationResult{}, false
	}
	if op.RunID != nil && *op.RunID != trimmedSessionID {
		jsonError(w, "operation session mismatch", http.StatusBadRequest)
		return "", breakdownOperationResult{}, false
	}
	if op.Status == "running" {
		jsonError(w, "breakdown still running", http.StatusConflict)
		return "", breakdownOperationResult{}, false
	}
	if op.Status == "failed" {
		jsonError(w, "breakdown operation failed", http.StatusBadRequest)
		return "", breakdownOperationResult{}, false
	}

	result, err := parseBreakdownOperationResult(op.QualityJSON)
	if err != nil {
		jsonError(w, "invalid breakdown operation result", http.StatusInternalServerError)
		return "", breakdownOperationResult{}, false
	}
	if result.Accepted || result.Rejected || len(result.Proposed) == 0 {
		jsonError(w, "no pending proposals for operation", http.StatusBadRequest)
		return "", breakdownOperationResult{}, false
	}
	return op.ID, result, true
}

func (s *Server) handlePlan(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type planReq struct {
		Goal      string `json:"goal"`
		Tool      string `json:"tool"`
		SessionID string `json:"session_id"`
	}
	req, ok := decodeJSON[planReq](w, r, false)
	if !ok {
		return
	}
	if req.Goal == "" {
		jsonError(w, "goal required", http.StatusBadRequest)
		return
	}
	sessionID := req.SessionID
	if sessionID == "" {
		sessionID = "default"
	}

	toolName, d, err := s.cfg.ResolveToolForPhase("plan", req.Tool)
	if err != nil {
		status := http.StatusInternalServerError
		if req.Tool != "" {
			status = http.StatusBadRequest
		}
		jsonError(w, err, status)
		return
	}

	s.runAsyncHandler(
		w,
		"breakdown",
		map[string]string{"status": "breaking_down"},
		func() {
			s.hub.Broadcast(Event{Type: "breakdown.started", Data: map[string]string{"session_id": sessionID}})
			model := s.cfg.ResolveModelForPhase("plan", "", d)
			breaker := breakdown.New(toolName, d, model, 10*time.Minute, s.repoDir, s.interactions)
			tasks, interactionID, err := breaker.Run(nil, req.Goal)
			if err != nil {
				data := map[string]string{"error": err.Error(), "session_id": sessionID}
				if interactionID != "" {
					data["operation_id"] = interactionID
				}
				s.hub.Broadcast(Event{Type: "breakdown.failed", Data: data})
				return
			}

			resultBytes, _ := json.Marshal(breakdownOperationResult{
				Goal:      req.Goal,
				SessionID: sessionID,
				Proposed:  tasks,
			})
			if interactionID != "" {
				_ = s.interactions.Finish(
					interactionID,
					"completed",
					interaction.WithQuality(string(resultBytes)),
					interaction.WithRunID(sessionID),
				)
			}
			data := map[string]interface{}{"proposed": tasks, "session_id": sessionID}
			if interactionID != "" {
				data["operation_id"] = interactionID
			}
			s.hub.Broadcast(Event{Type: "breakdown.completed", Data: data})
		},
	)
}

func (s *Server) handlePlanAccept(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type acceptReq struct {
		OperationID string                   `json:"operation_id"`
		SessionID   string                   `json:"session_id"`
		Tasks       []breakdown.ProposedTask `json:"tasks"`
	}
	req, ok := decodeJSON[acceptReq](w, r, false)
	if !ok {
		return
	}

	opID, result, ok := s.resolveBreakdownOp(w, req.OperationID, req.SessionID)
	if !ok {
		return
	}

	tasks := result.Proposed
	if req.Tasks != nil {
		tasks = req.Tasks
	}

	createdIDs, err := s.createTasksFromProposed(tasks)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	result.Accepted = true
	result.CreatedTaskIDs = createdIDs
	result.Proposed = nil
	resultBytes, _ := json.Marshal(result)
	if err := s.interactions.Finish(opID, "completed", interaction.WithQuality(string(resultBytes))); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{
		"created":      len(createdIDs),
		"task_ids":     createdIDs,
		"operation_id": opID,
	})
}

func (s *Server) handlePlanReject(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type rejectReq struct {
		OperationID string `json:"operation_id"`
		SessionID   string `json:"session_id"`
	}
	req, ok := decodeJSON[rejectReq](w, r, false)
	if !ok {
		return
	}

	opID := strings.TrimSpace(req.OperationID)
	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		sessionID = "default"
	}

	if opID == "" {
		resolvedID, _, err := s.findPendingBreakdownOperation(sessionID)
		if err == sql.ErrNoRows {
			jsonOK(w, map[string]interface{}{"rejected": false})
			return
		}
		if err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return
		}
		opID = *resolvedID
	}

	if op, err := s.interactions.Get(opID); err == nil && op.Phase == "breakdown" && op.Status == "failed" {
		jsonOK(w, map[string]interface{}{"rejected": false, "operation_id": opID})
		return
	}

	resolvedID, result, ok := s.resolveBreakdownOp(w, opID, sessionID)
	if !ok {
		return
	}

	result.Rejected = true
	result.Proposed = nil
	result.CreatedTaskIDs = nil
	resultBytes, _ := json.Marshal(result)
	if err := s.interactions.Finish(resolvedID, "completed", interaction.WithQuality(string(resultBytes))); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{"rejected": true, "operation_id": resolvedID})
}

func (s *Server) createTasksFromProposed(tasks []breakdown.ProposedTask) ([]string, error) {
	return s.createTasksFromProposedWithParent(tasks, "")
}

func (s *Server) createTasksFromProposedWithParent(tasks []breakdown.ProposedTask, parentID string) ([]string, error) {
	store := s.taskStore
	createdIDs := make([]string, len(tasks))
	for i, t := range tasks {
		created, err := store.Create(t.Title, t.Description, parentID)
		if err != nil {
			return nil, fmt.Errorf("create task %d: %w", i+1, err)
		}
		createdIDs[i] = created.ID
	}

	for i, t := range tasks {
		for _, depIdx := range t.DependsOnIndices {
			if depIdx >= 0 && depIdx < len(createdIDs) {
				_ = store.AddDependency(createdIDs[i], createdIDs[depIdx])
			}
		}
	}

	return createdIDs, nil
}
