package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/pod/internal/autopilot"
	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/cost"
	"github.com/jasjeetmavi/pod/internal/decompose"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/integrator"
	"github.com/jasjeetmavi/pod/internal/model"
	"github.com/jasjeetmavi/pod/internal/ops"
	"github.com/jasjeetmavi/pod/internal/plan"
	"github.com/jasjeetmavi/pod/internal/review"
	"github.com/jasjeetmavi/pod/internal/task"
	"github.com/jasjeetmavi/pod/internal/tasklog"
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

func (s *Server) handleGetTaskLogs(w http.ResponseWriter, r *http.Request, id string) {
	taskID := id
	store := task.NewStore(s.db)
	if resolved, err := store.ResolveID(id); err == nil {
		taskID = resolved
	}

	tail := 0
	if rawTail := strings.TrimSpace(r.URL.Query().Get("tail")); rawTail != "" {
		n, err := strconv.Atoi(rawTail)
		if err != nil || n < 0 {
			jsonError(w, "invalid tail parameter", http.StatusBadRequest)
			return
		}
		tail = n
	}

	follow := strings.EqualFold(r.URL.Query().Get("follow"), "true")
	readLines := func() ([]string, error) {
		if tail > 0 {
			return tasklog.ReadTailLines(s.repoDir, taskID, tail)
		}
		return tasklog.ReadLines(s.repoDir, taskID)
	}

	if !follow {
		lines, err := readLines()
		if err != nil {
			if os.IsNotExist(err) {
				jsonError(w, "log not found", http.StatusNotFound)
				return
			}
			jsonError(w, err, http.StatusInternalServerError)
			return
		}
		jsonOK(w, map[string]interface{}{"lines": lines})
		return
	}

	lines, err := readLines()
	if err != nil {
		if os.IsNotExist(err) {
			jsonError(w, "log not found", http.StatusNotFound)
			return
		}
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	sendLine := func(line string) bool {
		payload, _ := json.Marshal(map[string]string{"line": line})
		if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	for _, line := range lines {
		if !sendLine(line) {
			return
		}
	}

	if !s.executor.IsTaskRunning(taskID) {
		return
	}

	logPath := tasklog.Path(s.repoDir, taskID)
	st, err := os.Stat(logPath)
	if err != nil {
		return
	}
	offset := st.Size()
	carry := ""
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			st, err := os.Stat(logPath)
			if err != nil {
				if os.IsNotExist(err) {
					if !s.executor.IsTaskRunning(taskID) {
						return
					}
					continue
				}
				return
			}

			if st.Size() < offset {
				offset = 0
				carry = ""
			}
			if st.Size() > offset {
				f, err := os.Open(logPath)
				if err != nil {
					return
				}
				if _, err := f.Seek(offset, io.SeekStart); err != nil {
					_ = f.Close()
					return
				}
				chunk, err := io.ReadAll(f)
				_ = f.Close()
				if err != nil {
					return
				}

				offset = st.Size()
				text := carry + strings.ToValidUTF8(string(chunk), "?")
				parts := strings.Split(text, "\n")
				carry = parts[len(parts)-1]
				for _, line := range parts[:len(parts)-1] {
					if !sendLine(line) {
						return
					}
				}
			}

			if !s.executor.IsTaskRunning(taskID) && st.Size() == offset {
				if carry != "" {
					_ = sendLine(carry)
				}
				return
			}
		}
	}
}

func (s *Server) handleListLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	type logEntry struct {
		TaskID     string  `json:"task_id"`
		SizeBytes  int64   `json:"size_bytes"`
		ModifiedAt string  `json:"modified_at"`
		TaskTitle  *string `json:"task_title,omitempty"`
		TaskStatus *string `json:"task_status,omitempty"`
	}

	logsDir := filepath.Join(s.repoDir, ".pod", "logs")
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		if os.IsNotExist(err) {
			jsonOK(w, map[string]interface{}{"logs": []logEntry{}})
			return
		}
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	store := task.NewStore(s.db)
	allTasks, err := store.List()
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	taskByID := make(map[string]*task.Task, len(allTasks))
	for _, tk := range allTasks {
		taskByID[tk.ID] = tk
	}

	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))

	logs := make([]logEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if filepath.Ext(name) != ".log" {
			continue
		}

		taskID := strings.TrimSuffix(name, ".log")
		taskInfo := taskByID[taskID]
		if statusFilter != "" && (taskInfo == nil || taskInfo.Status != statusFilter) {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		item := logEntry{
			TaskID:     taskID,
			SizeBytes:  info.Size(),
			ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano),
		}
		if taskInfo != nil {
			item.TaskTitle = &taskInfo.Title
			item.TaskStatus = &taskInfo.Status
		}
		logs = append(logs, item)
	}

	sort.Slice(logs, func(i, j int) bool {
		return logs[i].ModifiedAt > logs[j].ModifiedAt
	})

	jsonOK(w, map[string]interface{}{"logs": logs})
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title        string `json:"title"`
		Description  string `json:"description"`
		ParentID     string `json:"parent_id"`
		Tool         string `json:"tool"`
		AssignedTool string `json:"assigned_tool"`
		Model        string `json:"model"`
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
		t, _ = store.Get(t.ID)
	}

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
	for _, key := range []string{"title", "description", "prompt", "status", "assigned_tool", "model"} {
		if v, ok := body[key]; ok {
			fields[key] = v
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
		case "completed", "running", "merged":
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

func (s *Server) handleDeleteTask(w http.ResponseWriter, r *http.Request, id string) {
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	if err := store.Delete(resolved); err != nil {
		jsonError(w, err, 500)
		return
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

	toolName := req.Tool
	if toolName == "" {
		toolName = tk.AssignedTool
	}

	var toolCfg config.ToolConfig
	if toolName != "" {
		tc, ok := s.cfg.Tools[toolName]
		if !ok {
			jsonError(w, fmt.Sprintf("tool %q not found", toolName), 400)
			return
		}
		toolCfg = tc
	} else {
		for _, tc := range s.cfg.Tools {
			toolCfg = tc
			break
		}
	}

	modelOverride := req.Model
	if modelOverride == "" {
		modelOverride = tk.Model
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
					log.Printf("mark plan operation failed %s: %v", opID, opErr)
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
				log.Printf("mark plan operation failed %s: %v", opID, err)
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
				log.Printf("mark plan operation failed %s: %v", opID, opErr)
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
			log.Printf("complete plan operation %s: %v", opID, err)
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
		if wt.Branch == "pod/integration" {
			continue
		}
		if !strings.HasPrefix(wt.Branch, "pod/task-") {
			continue
		}

		taskID := strings.TrimPrefix(wt.Branch, "pod/task-")
		tk, err := store.Get(taskID)
		if err != nil {
			stale = append(stale, staleEntry{taskID: taskID, branch: wt.Branch})
			continue
		}
		if tk.Status == "completed" || tk.Status == "failed" {
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
					log.Printf("mark cleanup operation failed %s: %v", opID, opErr)
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
				log.Printf("cleanup worktree %s: %v", st.branch, err)
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
				log.Printf("mark cleanup operation failed %s: %v", opID, opErr)
			}
			s.hub.Broadcast(Event{Type: "cleanup.failed", Data: map[string]interface{}{
				"operation_id": opID,
				"error":        errMsg,
			}})
			return
		}
		if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
			log.Printf("complete cleanup operation %s: %v", opID, err)
		}

		s.hub.Broadcast(Event{Type: "cleanup.completed", Data: map[string]interface{}{
			"operation_id": opID,
			"removed":      len(removedBranches),
		}})
	}(opID, stale)

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{"operation_id": opID})
}

// ========== Sprints ==========

func (s *Server) handleListSprints(w http.ResponseWriter, r *http.Request) {
	showAll := r.URL.Query().Get("all") == "true"
	query := `SELECT id, status, created_at, completed_at FROM sprints ORDER BY created_at DESC`
	if !showAll {
		query += ` LIMIT 10`
	}

	rows, err := s.db.Query(query)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	defer rows.Close()

	var sprints []map[string]interface{}
	for rows.Next() {
		var id, status string
		var createdAt time.Time
		var completedAt *time.Time
		if err := rows.Scan(&id, &status, &createdAt, &completedAt); err != nil {
			jsonError(w, err, 500)
			return
		}
		sp := map[string]interface{}{
			"id":         id,
			"status":     status,
			"created_at": createdAt,
		}
		if completedAt != nil {
			sp["completed_at"] = completedAt
		}
		sprints = append(sprints, sp)
	}
	jsonOK(w, map[string]interface{}{"sprints": sprints})
}

func (s *Server) handleGetActiveSprint(w http.ResponseWriter, r *http.Request) {
	active, err := s.planner.GetActive()
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	if active == nil {
		jsonOK(w, nil)
		return
	}
	jsonOK(w, active)
}

func (s *Server) handleGetSprint(w http.ResponseWriter, r *http.Request, id string) {
	sp, err := s.planner.Get(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	jsonOK(w, sp)
}

func (s *Server) handlePlanSprint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	active, err := s.planner.GetActive()
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	if active != nil {
		jsonError(w, fmt.Sprintf("sprint %s already active", active.ID[:8]), 409)
		return
	}

	sp, err := s.planner.Plan(s.cfg.Workers.MaxParallel)
	if err != nil {
		jsonError(w, err, 400)
		return
	}

	s.hub.Broadcast(Event{Type: "sprint.planned", Data: sp})
	jsonOK(w, sp)
}

func (s *Server) handleSprintAssign(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TaskID   string `json:"task_id"`
		SprintID string `json:"sprint_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	if req.TaskID == "" {
		jsonError(w, "task_id required", 400)
		return
	}

	store := task.NewStore(s.db)
	taskID, err := store.ResolveID(req.TaskID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	sprintID := req.SprintID
	if sprintID == "" {
		active, err := s.planner.GetActive()
		if err != nil {
			jsonError(w, err, 500)
			return
		}
		if active == nil {
			active, err = s.planner.CreateEmpty()
			if err != nil {
				jsonError(w, err, 500)
				return
			}
		}
		if active.Status != "planning" {
			jsonError(w, "sprint is running, cannot add tasks", 400)
			return
		}
		sprintID = active.ID
	}

	if err := s.planner.AddTaskToSprint(sprintID, taskID); err != nil {
		jsonError(w, err, 400)
		return
	}

	sp, err := s.planner.Get(sprintID)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	s.hub.Broadcast(Event{Type: "sprint.updated", Data: sp})
	jsonOK(w, sp)
}

func (s *Server) handleSprintUnassign(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TaskID string `json:"task_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	if req.TaskID == "" {
		jsonError(w, "task_id required", 400)
		return
	}

	store := task.NewStore(s.db)
	taskID, err := store.ResolveID(req.TaskID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	tk, err := store.Get(taskID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if tk.SprintID == "" {
		jsonError(w, "task is not assigned to a sprint", 400)
		return
	}

	if err := s.planner.RemoveTaskFromSprint(tk.SprintID, taskID); err != nil {
		jsonError(w, err, 400)
		return
	}

	sp, err := s.planner.Get(tk.SprintID)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	s.hub.Broadcast(Event{Type: "sprint.updated", Data: sp})
	jsonOK(w, map[string]string{"status": "ok"})
}

func (s *Server) handleStartSprint(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sp, err := s.planner.Get(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "sprint_start",
		TargetID: id,
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonResponse(w, 202, map[string]interface{}{"data": map[string]string{"sprint_id": id}})

	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("sprint panic: %v", rec)
				if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
					log.Printf("mark sprint operation failed %s: %v", opID, opErr)
				}
				log.Printf("sprint %s panicked: %v", id, rec)
				s.hub.Broadcast(Event{Type: "sprint.failed", Data: map[string]interface{}{"sprint_id": id, "error": errMsg}})
			}
		}()

		s.hub.Broadcast(Event{Type: "sprint.started", Data: map[string]string{"sprint_id": id}})

		results, err := s.executor.Run(sp)
		if err != nil {
			if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
				log.Printf("mark sprint operation failed %s: %v", opID, opErr)
			}
			log.Printf("sprint %s failed: %v", id, err)
			s.hub.Broadcast(Event{Type: "sprint.failed", Data: map[string]interface{}{"sprint_id": id, "error": err.Error()}})
			return
		}

		resultBytes, _ := json.Marshal(map[string]interface{}{
			"sprint_id": id,
			"results":   results,
		})
		if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
			log.Printf("complete sprint operation %s: %v", opID, err)
		}

		s.hub.Broadcast(Event{Type: "sprint.completed", Data: map[string]interface{}{
			"sprint_id": id,
			"results":   results,
		}})
	}()
}

func (s *Server) handleCancelSprint(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := s.executor.Cancel(); err != nil {
		jsonError(w, err, 500)
		return
	}

	sp, err := s.planner.Get(id)
	if err == nil {
		s.executor.Cleanup(sp)
		s.planner.ResetSprintTasks(id)
		s.planner.Fail(id)
	}

	s.hub.Broadcast(Event{Type: "sprint.cancelled", Data: map[string]string{"sprint_id": id}})
	jsonOK(w, map[string]string{"status": "cancelled", "sprint_id": id})
}

func (s *Server) handleResetSprint(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sp, err := s.planner.Get(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	s.executor.Cleanup(sp)
	if err := s.planner.ResetSprintTasks(id); err != nil {
		jsonError(w, err, 500)
		return
	}
	s.planner.Fail(id)

	s.hub.Broadcast(Event{Type: "sprint.reset", Data: map[string]string{"sprint_id": id}})
	jsonOK(w, map[string]string{"status": "reset", "sprint_id": id})
}

// ========== Sprint Review ==========

func (s *Server) handleGetReview(w http.ResponseWriter, r *http.Request, sprintID string) {
	sp, err := s.planner.Get(sprintID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	type artifact struct {
		TaskID     string   `json:"task_id"`
		Title      string   `json:"title"`
		Status     string   `json:"status"`
		Diff       string   `json:"diff,omitempty"`
		Files      []string `json:"files,omitempty"`
		DurationMs int64    `json:"duration_ms"`
	}

	var artifacts []artifact
	for _, taskID := range sp.TaskIDs {
		t, err := s.planner.GetTask(taskID)
		if err != nil {
			continue
		}

		a := artifact{TaskID: taskID, Title: t.Title, Status: t.Status}

		var diff, stdout, stderr string
		var exitCode int
		var durationMs int64
		artErr := s.db.QueryRow(
			`SELECT diff, stdout, stderr, exit_code, duration_ms FROM artifacts WHERE task_id = ? AND sprint_id = ?`,
			taskID, sprintID,
		).Scan(&diff, &stdout, &stderr, &exitCode, &durationMs)

		if artErr == nil {
			a.Diff = diff
			a.DurationMs = durationMs
			for _, line := range strings.Split(diff, "\n") {
				if strings.HasPrefix(line, "+++ b/") {
					a.Files = append(a.Files, strings.TrimPrefix(line, "+++ b/"))
				}
			}
		}
		artifacts = append(artifacts, a)
	}

	jsonOK(w, map[string]interface{}{"sprint_id": sprintID, "artifacts": artifacts})
}

func (s *Server) handlePostReview(w http.ResponseWriter, r *http.Request, sprintID string) {
	var req struct {
		Auto bool `json:"auto"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		jsonError(w, "invalid JSON", 400)
		return
	}

	if !req.Auto {
		jsonError(w, "set auto=true for automated review", 400)
		return
	}

	sp, err := s.planner.Get(sprintID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if _, err := s.ops.GetByTarget(sprintID, "review"); err == nil {
		jsonError(w, "review already in progress for sprint", http.StatusConflict)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		jsonError(w, err, 500)
		return
	}

	var reviewToolCfg config.ToolConfig
	for _, tc := range s.cfg.Tools {
		reviewToolCfg = tc
		break
	}

	var inputs []review.ReviewInput
	for _, taskID := range sp.TaskIDs {
		t, err := s.planner.GetTask(taskID)
		if err != nil || t.Status != "completed" {
			continue
		}

		var diff string
		s.db.QueryRow(`SELECT diff FROM artifacts WHERE task_id = ? AND sprint_id = ?`, taskID, sprintID).Scan(&diff)
		if diff == "" {
			continue
		}

		inputs = append(inputs, review.ReviewInput{
			TaskID:      taskID,
			Title:       t.Title,
			Description: t.Description,
			Diff:        diff,
		})
	}

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "review",
		TargetID: sprintID,
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	go func(opID, sprintID string, reviewToolCfg config.ToolConfig, inputs []review.ReviewInput) {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("review panic: %v", rec)
				if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
					log.Printf("mark review operation failed %s: %v", opID, opErr)
				}
				s.hub.Broadcast(Event{Type: "review.failed", Data: map[string]interface{}{
					"operation_id": opID,
					"error":        errMsg,
				}})
			}
		}()

		s.hub.Broadcast(Event{Type: "review.started", Data: map[string]interface{}{
			"operation_id": opID,
			"sprint_id":    sprintID,
		}})

		reviewer := review.New(reviewToolCfg, s.repoDir)
		results := make([]review.ReviewResult, 0, len(inputs))
		for _, in := range inputs {
			res, err := reviewer.Review(in.TaskID, in.Title, in.Description, in.Diff)
			if err != nil {
				results = append(results, review.ReviewResult{
					TaskID:   in.TaskID,
					Approved: false,
					Feedback: fmt.Sprintf("review error: %v", err),
					Tool:     reviewToolCfg.Binary,
				})
			} else {
				results = append(results, *res)
			}
			s.hub.Broadcast(Event{Type: "review.progress", Data: map[string]interface{}{
				"operation_id": opID,
				"task_id":      in.TaskID,
				"status":       "reviewed",
			}})
		}

		resultBytes, err := json.Marshal(map[string]interface{}{"results": results})
		if err != nil {
			errMsg := fmt.Sprintf("marshal review results: %v", err)
			if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
				log.Printf("mark review operation failed %s: %v", opID, opErr)
			}
			s.hub.Broadcast(Event{Type: "review.failed", Data: map[string]interface{}{
				"operation_id": opID,
				"error":        errMsg,
			}})
			return
		}
		if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
			log.Printf("complete review operation %s: %v", opID, err)
		}

		s.hub.Broadcast(Event{Type: "review.completed", Data: map[string]interface{}{
			"operation_id": opID,
			"sprint_id":    sprintID,
			"results":      results,
		}})
	}(opID, sprintID, reviewToolCfg, inputs)

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{"operation_id": opID})
}

// ========== Integrate ==========

// POST /api/v1/tasks/{id}/merge
func (s *Server) handleMergeTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Mode string `json:"mode"` // "" (default), "auto"
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
	if tk.Status != "completed" {
		jsonError(w, "only completed tasks can be merged", 400)
		return
	}

	// Check that all dependencies are merged first.
	for _, depID := range tk.DependsOn {
		dep, err := store.Get(depID)
		if err != nil {
			jsonError(w, fmt.Sprintf("failed to check dependency %s: %v", depID[:8], err), 500)
			return
		}
		if dep.Status != "merged" {
			jsonError(w, fmt.Sprintf("dependency %q (%s) must be merged first", dep.Title, dep.ID[:8]), 400)
			return
		}
	}

	ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "merge",
		TargetID: resolved,
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	mode := strings.TrimSpace(req.Mode)
	go func(taskID, mergeMode, operationID string) {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("merge panic: %v", rec)
				if opErr := s.ops.Fail(operationID, errMsg); opErr != nil {
					log.Printf("mark merge operation failed %s: %v", operationID, opErr)
				}
				s.hub.Broadcast(Event{Type: "merge.failed", Data: map[string]interface{}{
					"operation_id": operationID,
					"task_id":      taskID,
					"error":        errMsg,
				}})
			}
		}()

		s.hub.Broadcast(Event{Type: "merge.started", Data: map[string]interface{}{
			"operation_id": operationID,
			"task_id":      taskID,
			"mode":         mergeMode,
		}})

		var mergeErr error
		if mergeMode == "auto" {
			ig.SetRerunConfig(s.cfg.Project.WorktreeDir, func(id string) (config.ToolConfig, error) {
				return s.resolveToolConfigForTask(id)
			})
			s.hub.Broadcast(Event{Type: "merge.progress", Data: map[string]string{
				"task_id": taskID,
				"message": "Auto-resolving conflicts...",
			}})
			mergeErr = ig.MergeWithRerun(taskID)
		} else {
			mergeErr = ig.MergeAndValidate(taskID)
		}
		if mergeErr != nil {
			if opErr := s.ops.Fail(operationID, mergeErr.Error()); opErr != nil {
				log.Printf("mark merge operation failed %s: %v", operationID, opErr)
			}
			failData := map[string]interface{}{
				"operation_id": operationID,
				"task_id":      taskID,
				"error":        mergeErr.Error(),
			}
			if strings.Contains(strings.ToLower(mergeErr.Error()), "conflict") {
				failData["conflict"] = true
				failData["worktree_path"] = filepath.Join(s.cfg.Project.WorktreeDir, "task-"+taskID)
			}
			s.hub.Broadcast(Event{Type: "merge.failed", Data: failData})
			return
		}

		if err := store.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
			if opErr := s.ops.Fail(operationID, err.Error()); opErr != nil {
				log.Printf("mark merge operation failed %s: %v", operationID, opErr)
			}
			s.hub.Broadcast(Event{Type: "merge.failed", Data: map[string]interface{}{
				"operation_id": operationID,
				"task_id":      taskID,
				"error":        err.Error(),
			}})
			return
		}
		if err := s.executor.Worktrees().Remove(taskID); err != nil {
			log.Printf("cleanup worktree after merge %s: %v", taskID[:8], err)
		}

		updated, getErr := store.Get(taskID)
		if getErr != nil {
			log.Printf("load task after merge %s: %v", taskID[:8], getErr)
			updated = &task.Task{ID: taskID, Status: "merged"}
		}
		resultBytes, _ := json.Marshal(updated)
		if err := s.ops.Complete(operationID, string(resultBytes)); err != nil {
			log.Printf("complete merge operation %s: %v", operationID, err)
		}
		s.hub.Broadcast(Event{Type: "merge.completed", Data: updated})
		s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
	}(resolved, mode, opID)

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"data": map[string]string{"operation_id": opID},
	})
}

func (s *Server) resolveToolConfigForTask(taskID string) (config.ToolConfig, error) {
	store := task.NewStore(s.db)
	t, err := store.Get(taskID)
	if err != nil {
		return config.ToolConfig{}, err
	}

	name := t.AssignedTool
	if name != "" {
		if tc, ok := s.cfg.Tools[name]; ok {
			return tc, nil
		}
	}
	for _, tc := range s.cfg.Tools {
		return tc, nil
	}
	return config.ToolConfig{}, fmt.Errorf("no tools configured")
}

func (s *Server) handleIntegrate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		SprintID string `json:"sprint_id"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	sprintID := req.SprintID
	if sprintID == "" {
		err := s.db.QueryRow(
			`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`,
		).Scan(&sprintID)
		if err == sql.ErrNoRows {
			jsonError(w, "no completed sprints to integrate", 404)
			return
		}
		if err != nil {
			jsonError(w, err, 500)
			return
		}
	}

	if _, err := s.ops.GetByTarget("global", "integrate"); err == nil {
		jsonError(w, "integration already in progress", http.StatusConflict)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		jsonError(w, err, 500)
		return
	}

	sp, err := s.planner.Get(sprintID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	var taskIDs []string
	for _, id := range sp.TaskIDs {
		t, err := s.planner.GetTask(id)
		if err == nil && t.Status == "completed" {
			taskIDs = append(taskIDs, id)
		}
	}

	if len(taskIDs) == 0 {
		jsonError(w, "no completed tasks to integrate", 400)
		return
	}

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "integrate",
		TargetID: "global",
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"data": map[string]string{"operation_id": opID},
	})

	go func(operationID string, ids []string) {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("integrate panic: %v", rec)
				if opErr := s.ops.Fail(operationID, errMsg); opErr != nil {
					log.Printf("mark integrate operation failed %s: %v", operationID, opErr)
				}
				s.hub.Broadcast(Event{Type: "integrate.failed", Data: map[string]interface{}{
					"operation_id": operationID,
					"error":        errMsg,
				}})
			}
		}()

		ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
		store := task.NewStore(s.db)
		merged := make([]string, 0, len(ids))
		failed := make([]string, 0)

		s.hub.Broadcast(Event{Type: "integrate.started", Data: map[string]interface{}{
			"operation_id": operationID,
		}})

		for _, taskID := range ids {
			err := ig.MergeAndValidate(taskID)
			if err != nil {
				failed = append(failed, taskID)
				s.hub.Broadcast(Event{Type: "integrate.progress", Data: map[string]interface{}{
					"operation_id": operationID,
					"task_id":      taskID,
					"status":       "failed",
					"error":        err.Error(),
				}})
				continue
			}

			merged = append(merged, taskID)
			if err := store.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
				log.Printf("set task %s merged: %v", taskID, err)
			}
			if err := s.executor.Worktrees().Remove(taskID); err != nil {
				log.Printf("cleanup worktree after integrate %s: %v", taskID[:8], err)
			}
			if updated, err := store.Get(taskID); err == nil {
				s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
			}

			s.hub.Broadcast(Event{Type: "integrate.progress", Data: map[string]interface{}{
				"operation_id": operationID,
				"task_id":      taskID,
				"status":       "merged",
			}})
		}

		resultBytes, _ := json.Marshal(map[string]interface{}{
			"merged": merged,
			"failed": failed,
		})
		if err := s.ops.Complete(operationID, string(resultBytes)); err != nil {
			log.Printf("complete integrate operation %s: %v", operationID, err)
		}

		s.hub.Broadcast(Event{Type: "integrate.completed", Data: map[string]interface{}{
			"operation_id": operationID,
			"merged":       merged,
			"failed":       failed,
		}})
	}(opID, taskIDs)
}

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

func (s *Server) handleListOperations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	targetID := strings.TrimSpace(r.URL.Query().Get("target_id"))
	opType := strings.TrimSpace(r.URL.Query().Get("type"))

	query := `
		SELECT id, type, target_id, status, result, error, created_at, updated_at
		FROM operations
		WHERE (
			status = 'running'
			OR (status IN ('completed', 'failed') AND updated_at >= datetime('now', '-5 minutes'))
		)
	`
	args := make([]interface{}, 0, 2)
	if opType == "decompose" {
		// Decompose proposals are persisted and should be restorable after reconnect/restart.
		query = `
			SELECT id, type, target_id, status, result, error, created_at, updated_at
			FROM operations
			WHERE type = 'decompose'
		`
	}
	if targetID != "" {
		query += " AND target_id = ?"
		args = append(args, targetID)
	}
	if opType != "" && opType != "decompose" {
		query += " AND type = ?"
		args = append(args, opType)
	}
	query += " ORDER BY updated_at DESC"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	defer rows.Close()

	var operations []ops.Operation
	for rows.Next() {
		var op ops.Operation
		var result sql.NullString
		var errText sql.NullString
		if err := rows.Scan(
			&op.ID,
			&op.Type,
			&op.TargetID,
			&op.Status,
			&result,
			&errText,
			&op.CreatedAt,
			&op.UpdatedAt,
		); err != nil {
			jsonError(w, err, 500)
			return
		}
		if result.Valid {
			op.Result = result.String
		}
		if errText.Valid {
			op.Error = errText.String
		}
		operations = append(operations, op)
	}
	if err := rows.Err(); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonOK(w, map[string]interface{}{"operations": operations})
}

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
		for _, tc := range s.cfg.Tools {
			toolCfg = tc
			break
		}
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
					log.Printf("mark decompose operation failed %s: %v", operationID, opErr)
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
				log.Printf("mark decompose operation failed %s: %v", operationID, opErr)
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
			log.Printf("complete decompose operation %s: %v", operationID, err)
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

// ========== Autopilot ==========

func (s *Server) handleAutopilotStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Goal       string `json:"goal"`
		MaxSprints int    `json:"max_sprints"`
		Unattended bool   `json:"unattended"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	if req.Goal == "" {
		jsonError(w, "goal required", 400)
		return
	}

	s.autopilotMu.Lock()
	if s.autopilotCancel != nil {
		s.autopilotMu.Unlock()
		jsonError(w, "autopilot already running", 409)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.autopilotCancel = cancel
	s.autopilotResp = make(chan bool, 1)
	s.autopilotMu.Unlock()

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "autopilot",
		TargetID: "",
		Status:   "running",
	}); err != nil {
		s.autopilotMu.Lock()
		s.autopilotCancel = nil
		s.autopilotResp = nil
		s.autopilotMu.Unlock()
		cancel()
		jsonError(w, err, 500)
		return
	}

	opts := autopilot.Options{
		MaxSprints:    req.MaxSprints,
		PauseOnReview: !req.Unattended,
	}
	supervisor := autopilot.New(s.db, s.cfg, s.planner, s.executor, s.repoDir, opts)

	go func(goal string, unattended bool) {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("autopilot panic: %v", rec)
				if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
					log.Printf("mark autopilot operation failed %s: %v", opID, opErr)
				}
				s.hub.Broadcast(Event{Type: "autopilot.error", Data: map[string]string{"error": errMsg}})
			}
		}()

		defer func() {
			s.autopilotMu.Lock()
			s.autopilotCancel = nil
			s.autopilotResp = nil
			s.autopilotMu.Unlock()
		}()

		s.hub.Broadcast(Event{Type: "autopilot.started", Data: map[string]string{"goal": goal}})

		callback := s.makeAutopilotCallback(ctx, unattended)
		err := supervisor.Run(goal, callback)

		if err != nil {
			if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
				log.Printf("mark autopilot operation failed %s: %v", opID, opErr)
			}
			s.hub.Broadcast(Event{Type: "autopilot.error", Data: map[string]string{"error": err.Error()}})
			return
		}
		resultBytes, _ := json.Marshal(map[string]string{"goal": goal, "status": "completed"})
		if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
			log.Printf("complete autopilot operation %s: %v", opID, err)
		}
		s.hub.Broadcast(Event{Type: "autopilot.completed", Data: map[string]string{"goal": goal}})
	}(req.Goal, req.Unattended)

	jsonResponse(w, 202, map[string]interface{}{
		"data": map[string]string{
			"status": "started",
			"goal":   req.Goal,
		},
	})
}

func (s *Server) handleAutopilotStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.autopilotMu.Lock()
	cancel := s.autopilotCancel
	s.autopilotMu.Unlock()

	if cancel != nil {
		cancel()
	}
	s.executor.Cancel()

	s.hub.Broadcast(Event{Type: "autopilot.stopped", Data: map[string]string{}})
	jsonOK(w, map[string]string{"status": "stopped"})
}

func (s *Server) handleAutopilotRespond(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Continue bool `json:"continue"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	s.autopilotMu.Lock()
	ch := s.autopilotResp
	s.autopilotMu.Unlock()

	if ch != nil {
		select {
		case ch <- req.Continue:
		default:
		}
	}

	jsonOK(w, map[string]string{"status": "responded"})
}

func (s *Server) handleAutopilotStatus(w http.ResponseWriter, r *http.Request) {
	s.autopilotMu.Lock()
	autopilotRunning := s.autopilotCancel != nil
	s.autopilotMu.Unlock()

	active, _ := s.planner.GetActive()
	status := map[string]interface{}{
		"autopilot_running": autopilotRunning,
		"sprint_active":     active != nil,
	}
	if active != nil {
		status["sprint_id"] = active.ID
		status["sprint_status"] = active.Status
	}
	jsonOK(w, status)
}

func (s *Server) makeAutopilotCallback(ctx context.Context, unattended bool) autopilot.Callback {
	return func(event autopilot.Event) bool {
		select {
		case <-ctx.Done():
			return false
		default:
		}

		wsType := "autopilot.progress"
		switch event.Type {
		case autopilot.EventExploreComplete:
			wsType = "autopilot.explore_complete"
		case autopilot.EventPlanProposed:
			wsType = "autopilot.plan_proposed"
		case autopilot.EventSprintComplete:
			wsType = "autopilot.sprint_complete"
		case autopilot.EventReviewComplete:
			wsType = "autopilot.review_complete"
		case autopilot.EventIntegrateComplete:
			wsType = "autopilot.integrate_complete"
		case autopilot.EventEscalation:
			wsType = "autopilot.escalation"
		case autopilot.EventProgress:
			wsType = "autopilot.progress"
		}

		s.hub.Broadcast(Event{
			Type: wsType,
			Data: map[string]interface{}{
				"message": event.Message,
				"data":    event.Data,
			},
		})

		if event.Type == autopilot.EventEscalation && !unattended {
			return s.waitForAutopilotResponse(ctx)
		}

		if event.Type == autopilot.EventReviewComplete && !unattended {
			return s.waitForAutopilotResponse(ctx)
		}

		return true
	}
}

func (s *Server) waitForAutopilotResponse(ctx context.Context) bool {
	s.autopilotMu.Lock()
	ch := s.autopilotResp
	s.autopilotMu.Unlock()

	if ch == nil {
		return false
	}

	select {
	case <-ctx.Done():
		return false
	case response := <-ch:
		return response
	}
}

// ========== Costs ==========

func (s *Server) handleCosts(w http.ResponseWriter, r *http.Request) {
	ct := cost.NewTracker(s.db)
	sprintFlag := r.URL.Query().Get("sprint_id")

	if sprintFlag != "" {
		total, _ := ct.SprintTotal(sprintFlag)
		summary, _ := ct.SprintSummary(sprintFlag)
		jsonOK(w, map[string]interface{}{
			"sprint_id": sprintFlag,
			"total":     total,
			"tools":     summary,
		})
		return
	}

	projectTotal, _ := ct.ProjectTotal()
	summary, _ := ct.ProjectSummary()
	budget := s.cfg.Autopilot.CostBudget
	remaining, _ := ct.BudgetRemaining(budget)

	jsonOK(w, map[string]interface{}{
		"total":     projectTotal,
		"budget":    budget,
		"remaining": remaining,
		"tools":     summary,
	})
}

// ========== Config ==========

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, s.cfg)
}

func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	cfgPath := filepath.Join(".pod", "pod.yaml")
	for key, value := range body {
		switch key {
		case "autopilot.enabled":
			b, err := strconv.ParseBool(value)
			if err != nil {
				jsonError(w, fmt.Sprintf("invalid bool for %s", key), 400)
				return
			}
			s.cfg.Autopilot.Enabled = b
		case "autopilot.cost_budget":
			f, err := strconv.ParseFloat(value, 64)
			if err != nil {
				jsonError(w, fmt.Sprintf("invalid float for %s", key), 400)
				return
			}
			s.cfg.Autopilot.CostBudget = f
		case "autopilot.max_sprints":
			n, err := strconv.Atoi(value)
			if err != nil {
				jsonError(w, fmt.Sprintf("invalid int for %s", key), 400)
				return
			}
			s.cfg.Autopilot.MaxSprints = n
		case "autopilot.pause_on_review":
			b, err := strconv.ParseBool(value)
			if err != nil {
				jsonError(w, fmt.Sprintf("invalid bool for %s", key), 400)
				return
			}
			s.cfg.Autopilot.PauseOnReview = b
		case "autopilot.supervisor_tool":
			s.cfg.Autopilot.SupervisorTool = value
		case "workers.max_parallel":
			n, err := strconv.Atoi(value)
			if err != nil {
				jsonError(w, fmt.Sprintf("invalid int for %s", key), 400)
				return
			}
			s.cfg.Workers.MaxParallel = n
		default:
			jsonError(w, fmt.Sprintf("unknown config key: %s", key), 400)
			return
		}
	}

	if err := s.cfg.Save(cfgPath); err != nil {
		jsonError(w, err, 500)
		return
	}
	jsonOK(w, s.cfg)
}

// ========== Status ==========

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	store := task.NewStore(s.db)
	tasks, _ := store.List()

	counts := map[string]int{}
	for _, t := range tasks {
		counts[t.Status]++
	}

	active, _ := s.planner.GetActive()
	ct := cost.NewTracker(s.db)
	projectTotal, _ := ct.ProjectTotal()
	contextExists := explore.LoadContext(s.repoDir) != ""

	status := map[string]interface{}{
		"project":        s.cfg.Project.Name,
		"total_tasks":    len(tasks),
		"pending":        counts["pending"],
		"in_progress":    counts["in_sprint"] + counts["running"],
		"completed":      counts["completed"],
		"failed":         counts["failed"],
		"context_exists": contextExists,
		"total_cost":     projectTotal,
		"budget":         s.cfg.Autopilot.CostBudget,
	}

	if active != nil {
		status["active_sprint"] = map[string]string{
			"id":     active.ID,
			"status": active.Status,
		}
	}

	jsonOK(w, status)
}

// ========== Plan Sprint (standalone route) ==========

// This is the handler used by POST /api/v1/sprints/plan
// It's also called from routeSprintByID when the sub-path is "plan"
// but we already handle it above. Let's alias it for the mux entry:
func init() {
	// no-op; planSprint is called via routeSprintByID
}
