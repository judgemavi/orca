package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/evaluate"
	"github.com/jasjeetmavi/orca/internal/model"
	"github.com/jasjeetmavi/orca/internal/ops"
	"github.com/jasjeetmavi/orca/internal/plan"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
)

// ========== Tasks ==========

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	store := task.NewStore(s.db)
	status := r.URL.Query().Get("status")

	var tasks []*task.Task
	var err error
	if status != "" {
		tasks, err = store.ListByStatus(status)
	} else {
		tasks, err = store.List()
	}
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	jsonOK(w, map[string]interface{}{"tasks": tasks})
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request, id string) {
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	t, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	jsonOK(w, t)
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title        string               `json:"title"`
		Description  string               `json:"description"`
		ParentID     string               `json:"parent_id"`
		Tool         string               `json:"tool"`
		AssignedTool string               `json:"assigned_tool"`
		Model        string               `json:"model"`
		PhaseConfig  *task.PhaseConfigMap `json:"phase_config,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	if req.Title == "" {
		jsonError(w, "title required", 400)
		return
	}
	toolName := strings.TrimSpace(req.Tool)
	if toolName == "" {
		toolName = strings.TrimSpace(req.AssignedTool)
	}

	store := task.NewStore(s.db)
	t, err := store.Create(req.Title, req.Description, req.ParentID, toolName)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	if req.Model != "" {
		if err := store.Update(t.ID, map[string]interface{}{"model": req.Model}); err != nil {
			jsonError(w, err, 500)
			return
		}
	}
	if req.PhaseConfig != nil {
		data, err := json.Marshal(req.PhaseConfig)
		if err != nil {
			jsonError(w, err, 500)
			return
		}
		if err := store.Update(t.ID, map[string]interface{}{"phase_config": string(data)}); err != nil {
			jsonError(w, err, 500)
			return
		}
	}
	t, _ = store.Get(t.ID)

	s.hub.Broadcast(Event{Type: "task.created", Data: t})
	jsonResponse(w, 201, map[string]interface{}{"data": t})
}

func (s *Server) handleUpdateTask(w http.ResponseWriter, r *http.Request, id string) {
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	var body map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	fields := make(map[string]interface{})
	for _, key := range []string{"title", "description", "prompt", "status", "assigned_tool", "model", "phase_config"} {
		if v, ok := body[key]; ok {
			fields[key] = v
		}
	}
	if v, ok := fields["phase_config"]; ok && v != nil {
		data, err := json.Marshal(v)
		if err == nil {
			fields["phase_config"] = string(data)
		}
	}
	if len(fields) == 0 {
		jsonError(w, "no fields to update", 400)
		return
	}

	currentTask, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	if rawStatus, ok := fields["status"]; ok {
		newStatus, ok := rawStatus.(string)
		if !ok {
			jsonError(w, "status must be a string", 400)
			return
		}
		switch newStatus {
		case "pending":
			if currentTask.Status != "failed" {
				jsonError(w, "can only move failed tasks to pending", 400)
				return
			}
		case "in_sprint":
			jsonError(w, "use /api/v1/sprints/assign to add tasks to sprint", 400)
			return
		case "approved", "running", "merged", "review":
			jsonError(w, "cannot manually set status to "+newStatus, 400)
			return
		}
	}

	if err := store.Update(resolved, fields); err != nil {
		jsonError(w, err, 500)
		return
	}

	t, _ := store.Get(resolved)
	s.hub.Broadcast(Event{Type: "task.updated", Data: t})
	jsonOK(w, t)
}

// POST /api/v1/tasks/{id}/approve
func (s *Server) handleApproveTask(w http.ResponseWriter, r *http.Request, id string) {
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if tk.Status != "review" {
		jsonError(w, "task must be in review status to approve", 400)
		return
	}

	if err := store.Update(resolved, map[string]interface{}{"status": "approved"}); err != nil {
		jsonError(w, err, 500)
		return
	}
	if tk.SprintID != "" {
		if _, err := s.planner.CompleteSprintIfDone(tk.SprintID); err != nil {
			slog.Warn("check sprint completion after approve failed", "sprint_id", tk.SprintID, "err", err)
		}
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
	jsonOK(w, updated)
}

// POST /api/v1/tasks/{id}/request-changes
func (s *Server) handleRequestChanges(w http.ResponseWriter, r *http.Request, id string) {
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if tk.Status != "review" {
		jsonError(w, "task must be in review status to request changes", 400)
		return
	}

	var req struct {
		Feedback string `json:"feedback"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	feedback := strings.TrimSpace(req.Feedback)
	if feedback == "" {
		jsonError(w, "feedback required", 400)
		return
	}

	if _, err := store.AddReview(resolved, feedback); err != nil {
		jsonError(w, err, 500)
		return
	}
	if err := store.Update(resolved, map[string]interface{}{"status": "running"}); err != nil {
		jsonError(w, err, 500)
		return
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})

	go func(ctx context.Context, taskID string) {
		if err := s.executor.RunSingle(ctx, taskID); err != nil {
			slog.Error("request changes rerun failed", "task_id", taskID, "err", err)
		}
	}(s.ctx, resolved)

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"status":  "running",
		"task_id": resolved,
	})
}

func (s *Server) handleListTaskReviews(w http.ResponseWriter, r *http.Request, id string) {
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	reviews, err := store.ListReviews(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	jsonOK(w, map[string]interface{}{"reviews": reviews})
}

func (s *Server) handleDeleteTask(w http.ResponseWriter, r *http.Request, id string) {
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	sprintID := tk.SprintID
	if err := store.Delete(resolved); err != nil {
		jsonError(w, err, 400)
		return
	}
	// Best-effort worktree cleanup.
	if err := s.executor.Worktrees().Remove(resolved); err != nil {
		slog.Warn("cleanup worktree after delete", "task_id", resolved[:8], "err", err)
	}
	// End sprint if all its tasks have been deleted.
	if sprintID != "" {
		if _, err := s.planner.CompleteSprintIfDone(sprintID); err != nil {
			slog.Warn("check sprint after delete", "sprint_id", sprintID[:8], "err", err)
		}
	}

	s.hub.Broadcast(Event{Type: "task.deleted", Data: map[string]string{"id": resolved}})
	jsonOK(w, map[string]string{"deleted": resolved})
}

func (s *Server) handleAddDep(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	var req struct {
		DependsOn string `json:"depends_on"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	depResolved, err := store.ResolveID(req.DependsOn)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	if err := store.AddDependency(resolved, depResolved); err != nil {
		jsonError(w, err, 500)
		return
	}
	jsonOK(w, map[string]string{"task_id": resolved, "depends_on": depResolved})
}

func (s *Server) handleGetReady(w http.ResponseWriter, r *http.Request) {
	store := task.NewStore(s.db)
	tasks, err := store.GetReady()
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	jsonOK(w, map[string]interface{}{"tasks": tasks})
}

func (s *Server) handleListModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestedTool := strings.TrimSpace(r.URL.Query().Get("tool"))

	if requestedTool != "" {
		toolCfg, ok := s.cfg.Tools[requestedTool]
		if !ok {
			jsonError(w, fmt.Sprintf("tool %q not found", requestedTool), 400)
			return
		}
		resp := map[string][]model.Model{
			requestedTool: model.FromConfig(requestedTool, toolCfg),
		}
		jsonOK(w, map[string]interface{}{"tools": resp})
		return
	}

	jsonOK(w, map[string]interface{}{"tools": model.AllFromConfig(s.cfg)})
}

func (s *Server) handleGetTaskPlan(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	content, err := store.GetPlan(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonOK(w, map[string]string{"plan": content})
}

func (s *Server) handlePutTaskPlan(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Plan string `json:"plan"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	if err := store.SetPlan(resolved, req.Plan); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonOK(w, map[string]string{"plan": req.Plan})
}

func (s *Server) handleGenerateTaskPlan(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Tool  string `json:"tool"`
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		jsonError(w, "invalid JSON", 400)
		return
	}

	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if _, err := s.ops.GetByTarget(resolved, "plan_generate"); err == nil {
		jsonError(w, "plan generation already in progress", http.StatusConflict)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		jsonError(w, err, 500)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	var phaseOverride *task.PhaseOverride
	if tk.PhaseConfig != nil && !tk.PhaseConfig.UseDefaults {
		if p, ok := tk.PhaseConfig.Phases["plan"]; ok {
			phaseOverride = &p
		}
	}

	toolName := strings.TrimSpace(req.Tool)

	var toolCfg config.ToolConfig
	if toolName != "" {
		tc, ok := s.cfg.Tools[toolName]
		if !ok {
			jsonError(w, fmt.Sprintf("tool %q not found", toolName), 400)
			return
		}
		toolCfg = tc
	} else {
		if phaseOverride != nil && phaseOverride.Tool != "" {
			if tc, ok := s.cfg.Tools[phaseOverride.Tool]; ok {
				toolName = phaseOverride.Tool
				toolCfg = tc
			} else {
				slog.Warn("task phase_config tool not found in config, falling back", "tool", phaseOverride.Tool, "phase", "plan")
			}
		}
		if toolName == "" && tk.AssignedTool != "" {
			if tc, ok := s.cfg.Tools[tk.AssignedTool]; ok {
				toolName = tk.AssignedTool
				toolCfg = tc
			} else {
				slog.Warn("task assigned_tool not found in config, falling back to plan phase default", "assigned_tool", tk.AssignedTool)
			}
		}
		if toolName == "" {
			var err error
			toolName, toolCfg, err = s.cfg.ResolvePhaseToolConfig("plan")
			if err != nil {
				jsonError(w, err, 500)
				return
			}
		}
	}

	modelOverride := strings.TrimSpace(req.Model)
	if modelOverride == "" && phaseOverride != nil {
		modelOverride = validateTaskModelOverride(toolName, phaseOverride.Model, toolCfg)
	}
	if modelOverride == "" {
		modelOverride = validateTaskModelOverride(toolName, tk.Model, toolCfg)
	}
	if modelOverride == "" {
		if _, phaseToolCfg, err := s.cfg.ResolvePhaseToolConfig("plan"); err == nil {
			modelOverride = validateTaskModelOverride(toolName, phaseToolCfg.Model, toolCfg)
		}
	}

	s.hub.Broadcast(Event{
		Type: "plan.generating",
		Data: map[string]string{"task_id": resolved},
	})

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "plan_generate",
		TargetID: resolved,
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	go func(taskID, title, description, model string, cfg config.ToolConfig) {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("plan_generate panic: %v", rec)
				if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
					slog.Error("mark plan operation failed", "operation_id", opID, "err", opErr)
				}
				s.hub.Broadcast(Event{
					Type: "plan.failed",
					Data: map[string]string{
						"task_id": taskID,
						"error":   errMsg,
					},
				})
			}
		}()

		generator := plan.New(cfg, s.repoDir)
		var content string
		var genErr error
		if model != "" {
			content, genErr = generator.GenerateWithModel(title, description, model)
		} else {
			content, genErr = generator.Generate(title, description)
		}
		if genErr != nil {
			if err := s.ops.Fail(opID, genErr.Error()); err != nil {
				slog.Error("mark plan operation failed", "operation_id", opID, "err", err)
			}
			s.hub.Broadcast(Event{
				Type: "plan.failed",
				Data: map[string]string{
					"task_id": taskID,
					"error":   genErr.Error(),
				},
			})
			return
		}

		store := task.NewStore(s.db)
		if err := store.SetPlan(taskID, content); err != nil {
			if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
				slog.Error("mark plan operation failed", "operation_id", opID, "err", opErr)
			}
			s.hub.Broadcast(Event{
				Type: "plan.failed",
				Data: map[string]string{
					"task_id": taskID,
					"error":   err.Error(),
				},
			})
			return
		}

		resultBytes, _ := json.Marshal(map[string]string{
			"task_id": taskID,
			"plan":    content,
		})
		if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
			slog.Debug("complete plan operation failed", "operation_id", opID, "err", err)
		}

		s.hub.Broadcast(Event{
			Type: "plan.completed",
			Data: map[string]string{
				"task_id": taskID,
				"plan":    content,
			},
		})
	}(resolved, tk.Title, tk.Description, modelOverride, toolCfg)

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"data": map[string]string{"status": "generating"},
	})
}

// POST /api/v1/tasks/{id}/evaluate
func (s *Server) handleEvaluateTask(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Tool  string `json:"tool"`
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		jsonError(w, "invalid JSON", 400)
		return
	}

	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	toolName := strings.TrimSpace(req.Tool)
	if toolName == "" {
		toolName = strings.TrimSpace(tk.AssignedTool)
	}
	if toolName == "" {
		toolName = strings.TrimSpace(s.cfg.Defaults.Tool)
	}
	if toolName == "" {
		for name := range s.cfg.Tools {
			toolName = name
			break
		}
	}
	if toolName == "" {
		jsonError(w, "no tools configured", 500)
		return
	}

	toolCfg, ok := s.cfg.Tools[toolName]
	if !ok {
		jsonError(w, fmt.Sprintf("tool %q not found in config", toolName), 500)
		return
	}

	evaluator := evaluate.New(toolCfg, s.repoDir)
	modelOverride := strings.TrimSpace(req.Model)

	var result *evaluate.EvaluationResult
	if modelOverride != "" {
		result, err = evaluator.EvaluateWithModel(tk.Title, tk.Description, modelOverride)
	} else {
		result, err = evaluator.Evaluate(tk.Title, tk.Description)
	}
	if err != nil {
		jsonError(w, fmt.Sprintf("evaluate plan: %v", err), 500)
		return
	}

	jsonOK(w, map[string]interface{}{
		"task_id":    resolved,
		"evaluation": result,
	})
}

func validateTaskModelOverride(toolName, model string, toolCfg config.ToolConfig) string {
	if model == "" {
		return ""
	}
	for _, m := range toolCfg.Models {
		if m == model {
			return model
		}
	}
	slog.Warn("task model not in tool models list, using default", "model", model, "tool", toolName)
	return ""
}

func (s *Server) handleReopenTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if tk.Status != "failed" {
		jsonError(w, fmt.Sprintf("task %s is %q, not %q", resolved[:8], tk.Status, "failed"), 400)
		return
	}

	if err := store.Update(resolved, map[string]interface{}{"status": "pending", "sprint_id": nil}); err != nil {
		jsonError(w, err, 500)
		return
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
	jsonOK(w, updated)
}

func (s *Server) handleCleanup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		DryRun bool `json:"dry_run"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		jsonError(w, "invalid JSON", 400)
		return
	}

	store := task.NewStore(s.db)
	wm := s.executor.Worktrees()
	worktreeList, err := wm.List()
	if err != nil {
		jsonError(w, fmt.Errorf("list worktrees: %w", err), 500)
		return
	}

	type staleEntry struct {
		taskID string
		branch string
	}

	var stale []staleEntry
	for _, wt := range worktreeList {
		if wt.Branch == "main" || wt.Branch == "master" || wt.Branch == "" {
			continue
		}
		if wt.Branch == "orca/integration" {
			continue
		}
		if !strings.HasPrefix(wt.Branch, "orca/task-") {
			continue
		}

		taskID := worktree.ExtractTaskID(wt.Branch)
		tk, err := store.Get(taskID)
		if err != nil {
			stale = append(stale, staleEntry{taskID: taskID, branch: wt.Branch})
			continue
		}
		if tk.Status == "approved" || tk.Status == "failed" {
			stale = append(stale, staleEntry{taskID: taskID, branch: wt.Branch})
		}
	}

	if req.DryRun {
		removedBranches := make([]string, 0, len(stale))
		for _, st := range stale {
			removedBranches = append(removedBranches, st.branch)
		}
		jsonOK(w, map[string]interface{}{
			"removed":   len(removedBranches),
			"worktrees": removedBranches,
		})
		return
	}

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "cleanup",
		TargetID: "global",
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	go func(opID string, stale []staleEntry) {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("cleanup panic: %v", rec)
				if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
					slog.Error("mark cleanup operation failed", "operation_id", opID, "err", opErr)
				}
				s.hub.Broadcast(Event{Type: "cleanup.failed", Data: map[string]interface{}{
					"operation_id": opID,
					"error":        errMsg,
				}})
			}
		}()

		s.hub.Broadcast(Event{Type: "cleanup.started", Data: map[string]interface{}{
			"operation_id": opID,
		}})

		removedBranches := make([]string, 0, len(stale))
		for _, st := range stale {
			if err := wm.Remove(st.taskID); err != nil {
				slog.Warn("cleanup worktree failed", "branch", st.branch, "task_id", st.taskID, "err", err)
				continue
			}
			removedBranches = append(removedBranches, st.branch)
			s.hub.Broadcast(Event{Type: "cleanup.progress", Data: map[string]interface{}{
				"operation_id": opID,
				"removed":      st.branch,
			}})
		}

		resultBytes, err := json.Marshal(map[string]interface{}{
			"removed":   len(removedBranches),
			"worktrees": removedBranches,
		})
		if err != nil {
			errMsg := fmt.Sprintf("marshal cleanup result: %v", err)
			if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
				slog.Error("mark cleanup operation failed", "operation_id", opID, "err", opErr)
			}
			s.hub.Broadcast(Event{Type: "cleanup.failed", Data: map[string]interface{}{
				"operation_id": opID,
				"error":        errMsg,
			}})
			return
		}
		if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
			slog.Debug("complete cleanup operation failed", "operation_id", opID, "err", err)
		}

		s.hub.Broadcast(Event{Type: "cleanup.completed", Data: map[string]interface{}{
			"operation_id": opID,
			"removed":      len(removedBranches),
		}})
	}(opID, stale)

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{"operation_id": opID})
}
