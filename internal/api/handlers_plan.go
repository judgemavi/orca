package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jasjeetmavi/orca/internal/decompose"
	"github.com/jasjeetmavi/orca/internal/ops"
)

// ========== Plan (Decompose) ==========

type decomposeOperationResult struct {
	Goal           string                   `json:"goal,omitempty"`
	SessionID      string                   `json:"session_id,omitempty"`
	Proposed       []decompose.ProposedTask `json:"proposed,omitempty"`
	Accepted       bool                     `json:"accepted,omitempty"`
	Rejected       bool                     `json:"rejected,omitempty"`
	CreatedTaskIDs []string                 `json:"created_task_ids,omitempty"`
}

func parseDecomposeOperationResult(raw string) (decomposeOperationResult, error) {
	if strings.TrimSpace(raw) == "" {
		return decomposeOperationResult{}, nil
	}
	var out decomposeOperationResult
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return decomposeOperationResult{}, err
	}
	return out, nil
}

func (s *Server) findPendingDecomposeOperation(sessionID string) (*ops.Operation, decomposeOperationResult, error) {
	all, err := s.ops.ListByType("decompose")
	if err != nil {
		return nil, decomposeOperationResult{}, err
	}
	for _, op := range all {
		if op.TargetID != sessionID || op.Status != "completed" {
			continue
		}
		result, err := parseDecomposeOperationResult(op.Result)
		if err != nil {
			continue
		}
		if result.Accepted || result.Rejected || len(result.Proposed) == 0 {
			continue
		}
		opCopy := op
		return &opCopy, result, nil
	}
	return nil, decomposeOperationResult{}, sql.ErrNoRows
}

func (s *Server) resolveDecomposeOp(w http.ResponseWriter, opID, sessionID string) (*ops.Operation, decomposeOperationResult, bool) {
	trimmedOpID := strings.TrimSpace(opID)
	trimmedSessionID := strings.TrimSpace(sessionID)
	if trimmedSessionID == "" {
		trimmedSessionID = "default"
	}

	if trimmedOpID == "" {
		op, result, err := s.findPendingDecomposeOperation(trimmedSessionID)
		if err == sql.ErrNoRows {
			jsonError(w, "no pending plan for session", http.StatusNotFound)
			return nil, decomposeOperationResult{}, false
		}
		if err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return nil, decomposeOperationResult{}, false
		}
		return op, result, true
	}

	op, err := s.ops.Get(trimmedOpID)
	if err != nil {
		jsonError(w, "decompose operation not found", http.StatusNotFound)
		return nil, decomposeOperationResult{}, false
	}
	if op.Type != "decompose" {
		jsonError(w, "operation is not decompose", http.StatusBadRequest)
		return nil, decomposeOperationResult{}, false
	}
	if op.Status == "running" {
		jsonError(w, "decompose still running", http.StatusConflict)
		return nil, decomposeOperationResult{}, false
	}
	if op.Status == "failed" {
		jsonError(w, "decompose operation failed", http.StatusBadRequest)
		return nil, decomposeOperationResult{}, false
	}

	result, err := parseDecomposeOperationResult(op.Result)
	if err != nil {
		jsonError(w, "invalid decompose operation result", http.StatusInternalServerError)
		return nil, decomposeOperationResult{}, false
	}
	if result.Accepted || result.Rejected || len(result.Proposed) == 0 {
		jsonError(w, "no pending proposals for operation", http.StatusBadRequest)
		return nil, decomposeOperationResult{}, false
	}
	return op, result, true
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

	_, toolCfg, err := s.cfg.ResolveToolForPhase(nil, "plan", req.Tool)
	if err != nil {
		status := http.StatusInternalServerError
		if req.Tool != "" {
			status = http.StatusBadRequest
		}
		jsonError(w, err, status)
		return
	}

	opID := ""
	opID = s.startAsyncOp(
		w,
		"decompose",
		sessionID,
		"decompose",
		map[string]interface{}{"operation_id": ""},
		map[string]string{
			"status":       "decomposing",
			"operation_id": "",
		},
		func() {
			operationID := opID
			s.hub.Broadcast(Event{Type: "decompose.started", Data: map[string]string{"operation_id": operationID}})
			d := decompose.New(toolCfg, s.repoDir)
			tasks, err := d.Run(req.Goal)
			if err != nil {
				if opErr := s.ops.Fail(operationID, err.Error()); opErr != nil {
					slog.Error("mark decompose operation failed", "operation_id", operationID, "err", opErr)
				}
				s.hub.Broadcast(Event{Type: "decompose.failed", Data: map[string]string{
					"operation_id": operationID,
					"error":        err.Error(),
				}})
				return
			}

			resultBytes, _ := json.Marshal(decomposeOperationResult{
				Goal:      req.Goal,
				SessionID: sessionID,
				Proposed:  tasks,
			})
			if err := s.ops.Complete(operationID, string(resultBytes)); err != nil {
				slog.Debug("complete decompose operation failed", "operation_id", operationID, "err", err)
			}
			s.hub.Broadcast(Event{Type: "decompose.completed", Data: map[string]interface{}{
				"operation_id": operationID,
				"proposed":     tasks,
			}})
		},
	)
	if opID == "" {
		return
	}
}

func (s *Server) handlePlanAccept(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type acceptReq struct {
		OperationID string                   `json:"operation_id"`
		SessionID   string                   `json:"session_id"`
		Tasks       []decompose.ProposedTask `json:"tasks"`
	}
	req, ok := decodeJSON[acceptReq](w, r, false)
	if !ok {
		return
	}

	op, result, ok := s.resolveDecomposeOp(w, req.OperationID, req.SessionID)
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
	if err := s.ops.Complete(op.ID, string(resultBytes)); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{
		"created":      len(createdIDs),
		"task_ids":     createdIDs,
		"operation_id": op.ID,
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
		op, _, err := s.findPendingDecomposeOperation(sessionID)
		if err == sql.ErrNoRows {
			jsonOK(w, map[string]interface{}{"rejected": false})
			return
		}
		if err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return
		}
		opID = op.ID
	}

	if op, err := s.ops.Get(opID); err == nil && op.Type == "decompose" && op.Status == "failed" {
		jsonOK(w, map[string]interface{}{"rejected": false, "operation_id": opID})
		return
	}

	op, result, ok := s.resolveDecomposeOp(w, opID, sessionID)
	if !ok {
		return
	}

	result.Rejected = true
	result.Proposed = nil
	result.CreatedTaskIDs = nil
	resultBytes, _ := json.Marshal(result)
	if err := s.ops.Complete(op.ID, string(resultBytes)); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{"rejected": true, "operation_id": op.ID})
}

func (s *Server) createTasksFromProposed(tasks []decompose.ProposedTask) ([]string, error) {
	store := s.taskStore
	createdIDs := make([]string, len(tasks))
	for i, t := range tasks {
		created, err := store.Create(t.Title, t.Description, "", t.SuggestedTool)
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
