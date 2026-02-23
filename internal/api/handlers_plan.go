package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/decompose"
	"github.com/jasjeetmavi/orca/internal/ops"
	"github.com/jasjeetmavi/orca/internal/task"
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

func (s *Server) handlePlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Goal      string `json:"goal"`
		Tool      string `json:"tool"`
		SessionID string `json:"session_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	if req.Goal == "" {
		jsonError(w, "goal required", 400)
		return
	}
	sessionID := req.SessionID
	if sessionID == "" {
		sessionID = "default"
	}

	var toolCfg config.ToolConfig
	if req.Tool != "" {
		tc, ok := s.cfg.Tools[req.Tool]
		if !ok {
			jsonError(w, fmt.Sprintf("tool %q not found", req.Tool), 400)
			return
		}
		toolCfg = tc
	} else {
		_, tc, err := s.cfg.ResolvePhaseToolConfig("plan")
		if err != nil {
			jsonError(w, err, 500)
			return
		}
		toolCfg = tc
	}

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "decompose",
		TargetID: sessionID,
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}
	s.hub.Broadcast(Event{Type: "decompose.started", Data: map[string]string{"operation_id": opID}})
	jsonResponse(w, 202, map[string]interface{}{
		"data": map[string]string{
			"status":       "decomposing",
			"operation_id": opID,
		},
	})

	go func(goal string, tool config.ToolConfig, operationID string) {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("decompose panic: %v", rec)
				if opErr := s.ops.Fail(operationID, errMsg); opErr != nil {
					slog.Error("mark decompose operation failed", "operation_id", operationID, "err", opErr)
				}
				s.hub.Broadcast(Event{Type: "decompose.failed", Data: map[string]string{
					"operation_id": operationID,
					"error":        errMsg,
				}})
			}
		}()

		d := decompose.New(tool, s.repoDir)
		tasks, err := d.Run(goal)
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
			Goal:      goal,
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
	}(req.Goal, toolCfg, opID)
}

func (s *Server) handlePlanAccept(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		OperationID string                   `json:"operation_id"`
		SessionID   string                   `json:"session_id"`
		Tasks       []decompose.ProposedTask `json:"tasks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	opID := strings.TrimSpace(req.OperationID)
	var (
		op     *ops.Operation
		result decomposeOperationResult
		err    error
	)
	if opID == "" {
		sessionID := strings.TrimSpace(req.SessionID)
		if sessionID == "" {
			sessionID = "default"
		}
		op, result, err = s.findPendingDecomposeOperation(sessionID)
		if err == sql.ErrNoRows {
			jsonError(w, "no pending plan for session", 404)
			return
		}
		if err != nil {
			jsonError(w, err, 500)
			return
		}
		opID = op.ID
	} else {
		op, err = s.ops.Get(opID)
		if err != nil {
			jsonError(w, "decompose operation not found", 404)
			return
		}
		if op.Type != "decompose" {
			jsonError(w, "operation is not decompose", 400)
			return
		}
		if op.Status == "running" {
			jsonError(w, "decompose still running", 409)
			return
		}
		if op.Status == "failed" {
			jsonError(w, "decompose operation failed", 400)
			return
		}
		result, err = parseDecomposeOperationResult(op.Result)
		if err != nil {
			jsonError(w, "invalid decompose operation result", 500)
			return
		}
	}

	if result.Accepted || result.Rejected || len(result.Proposed) == 0 {
		jsonError(w, "no pending proposals for operation", 400)
		return
	}

	tasks := result.Proposed
	if req.Tasks != nil {
		tasks = req.Tasks
	}

	createdIDs, err := s.createTasksFromProposed(tasks)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	result.Accepted = true
	result.CreatedTaskIDs = createdIDs
	result.Proposed = nil
	resultBytes, _ := json.Marshal(result)
	if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonOK(w, map[string]interface{}{
		"created":      len(createdIDs),
		"task_ids":     createdIDs,
		"operation_id": opID,
	})
}

func (s *Server) handlePlanReject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		OperationID string `json:"operation_id"`
		SessionID   string `json:"session_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	opID := strings.TrimSpace(req.OperationID)
	var (
		op     *ops.Operation
		result decomposeOperationResult
		err    error
	)
	if opID == "" {
		sessionID := strings.TrimSpace(req.SessionID)
		if sessionID == "" {
			sessionID = "default"
		}
		op, result, err = s.findPendingDecomposeOperation(sessionID)
		if err == sql.ErrNoRows {
			jsonOK(w, map[string]interface{}{"rejected": false})
			return
		}
		if err != nil {
			jsonError(w, err, 500)
			return
		}
		opID = op.ID
	} else {
		op, err = s.ops.Get(opID)
		if err != nil {
			jsonError(w, "decompose operation not found", 404)
			return
		}
		if op.Type != "decompose" {
			jsonError(w, "operation is not decompose", 400)
			return
		}
		if op.Status == "running" {
			jsonError(w, "decompose still running", 409)
			return
		}
		if op.Status == "failed" {
			jsonOK(w, map[string]interface{}{"rejected": false, "operation_id": opID})
			return
		}
		result, err = parseDecomposeOperationResult(op.Result)
		if err != nil {
			jsonError(w, "invalid decompose operation result", 500)
			return
		}
	}

	result.Rejected = true
	result.Proposed = nil
	result.CreatedTaskIDs = nil
	resultBytes, _ := json.Marshal(result)
	if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonOK(w, map[string]interface{}{"rejected": true, "operation_id": opID})
}

func (s *Server) createTasksFromProposed(tasks []decompose.ProposedTask) ([]string, error) {
	store := task.NewStore(s.db)
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
