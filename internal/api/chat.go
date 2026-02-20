package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/cost"
	"github.com/jasjeetmavi/pod/internal/decompose"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/integrator"
	"github.com/jasjeetmavi/pod/internal/model"
	"github.com/jasjeetmavi/pod/internal/ops"
	planpkg "github.com/jasjeetmavi/pod/internal/plan"
	"github.com/jasjeetmavi/pod/internal/task"
)

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Message   string `json:"message"`
		SessionID string `json:"session_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	intent := ParseIntent(req.Message)
	if intent.Action == "unknown" || len(strings.Fields(req.Message)) > 2 {
		if s.resolver != nil {
			resolvedIntent, err := s.resolver.Resolve(req.Message)
			if err != nil {
				log.Printf("chat intent resolver failed, using ParseIntent fallback: %v", err)
				intent = ParseIntent(req.Message)
			} else {
				intent = resolvedIntent
				if intent.Action == "unknown" {
					intent = ParseIntent(req.Message)
				}
			}
		}
	}

	blocks := s.executeIntent(intent, req.SessionID)

	jsonOK(w, map[string]interface{}{
		"id":        uuid.New().String(),
		"role":      "assistant",
		"timestamp": time.Now().UTC(),
		"blocks":    blocks,
	})
}

func (s *Server) executeIntent(intent Intent, sessionID string) []Block {
	switch intent.Action {
	case "models":
		return s.chatModels(intent.Args["tool"])
	case "status":
		return s.chatStatus()
	case "task.list":
		return s.chatTaskList()
	case "task.show":
		return s.chatTaskShow(intent.Args["id"])
	case "task.create":
		return s.chatTaskCreate(intent.Args["title"])
	case "task.update":
		return s.chatTaskUpdate(intent.Args["id"], intent.Args["rest"])
	case "task.delete":
		return s.chatTaskDelete(intent.Args["id"])
	case "task.plan":
		return s.chatTaskPlan(intent.Args["id"])
	case "plan":
		return s.chatPlan(intent.Args["goal"], sessionID)
	case "plan.accept":
		return s.chatPlanAccept(sessionID)
	case "explore":
		return s.chatExplore()
	case "sprint.plan":
		return s.chatSprintPlan()
	case "sprint.start":
		return s.chatSprintStart()
	case "sprint.status":
		return s.chatSprintStatus()
	case "sprint.assign":
		return s.chatSprintAssign(intent.Args["ids"])
	case "sprint.unassign":
		return s.chatSprintUnassign(intent.Args["ids"])
	case "sprint.cancel":
		return s.chatSprintCancel()
	case "sprint.reset":
		return s.chatSprintReset()
	case "task.reopen":
		return s.chatTaskReopen(intent.Args["ids"])
	case "review":
		return s.chatReview()
	case "review.auto":
		return s.chatAutoReview()
	case "integrate":
		return s.chatIntegrate()
	case "costs":
		return s.chatCosts()
	case "config":
		return s.chatConfig()
	case "cleanup":
		return s.chatCleanup()
	case "autopilot":
		return []Block{TextBlock("Use POST /api/v1/autopilot/start to run autopilot")}
	case "autopilot.stop":
		s.executor.Cancel()
		return []Block{TextBlock("Autopilot stopped")}
	case "autopilot.respond":
		s.autopilotMu.Lock()
		ch := s.autopilotResp
		s.autopilotMu.Unlock()
		if ch != nil {
			select {
			case ch <- true:
			default:
			}
		}
		return []Block{TextBlock("Continuing...")}
	case "help":
		return []Block{HelpBlock()}
	case "conversation":
		return []Block{TextBlock(intent.Args["message"])}
	default:
		return []Block{TextBlock(fmt.Sprintf("I don't understand %q. Type 'help' for available commands.", intent.Args["message"]))}
	}
}

func (s *Server) chatModels(tool string) []Block {
	var lines []string

	if tool != "" {
		tc, ok := s.cfg.Tools[tool]
		if !ok {
			return []Block{TextBlock(fmt.Sprintf("Error: tool %q not found", tool))}
		}
		models := model.FromConfig(tool, tc)
		if len(models) == 0 {
			return []Block{TextBlock(fmt.Sprintf("%s: no models configured", tool))}
		}
		lines = append(lines, tool+":")
		for _, m := range models {
			lines = append(lines, fmt.Sprintf("  - %s", m.ID))
		}
		return []Block{TextBlock(strings.Join(lines, "\n"))}
	}

	toolNames := make([]string, 0, len(s.cfg.Tools))
	for name := range s.cfg.Tools {
		toolNames = append(toolNames, name)
	}
	sort.Strings(toolNames)

	for _, name := range toolNames {
		tc := s.cfg.Tools[name]
		models := model.FromConfig(name, tc)
		if len(models) == 0 {
			lines = append(lines, fmt.Sprintf("%s: no models configured", name))
			continue
		}
		lines = append(lines, name+":")
		for _, m := range models {
			lines = append(lines, fmt.Sprintf("  - %s", m.ID))
		}
	}
	if len(lines) == 0 {
		lines = append(lines, "No tools configured.")
	}
	return []Block{TextBlock(strings.Join(lines, "\n"))}
}

func (s *Server) chatStatus() []Block {
	store := task.NewStore(s.db)
	tasks, _ := store.List()
	counts := map[string]int{}
	for _, t := range tasks {
		counts[t.Status]++
	}

	active, _ := s.planner.GetActive()
	ct := cost.NewTracker(s.db)
	projectTotal, _ := ct.ProjectTotal()
	budget := s.cfg.Autopilot.CostBudget
	remaining, _ := ct.BudgetRemaining(budget)

	ps := ProjectStatus{
		ProjectName:     s.cfg.Project.Name,
		TaskCounts:      counts,
		ContextExists:   explore.LoadContext(s.repoDir) != "",
		TotalCost:       projectTotal,
		Budget:          budget,
		BudgetRemaining: remaining,
	}
	if active != nil {
		ps.ActiveSprint = map[string]string{"id": active.ID, "status": active.Status}
	}
	return []Block{StatusCardBlock(ps)}
}

func (s *Server) chatTaskList() []Block {
	store := task.NewStore(s.db)
	tasks, err := store.List()
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	if len(tasks) == 0 {
		return []Block{TextBlock("No tasks in backlog.")}
	}
	return []Block{TaskListBlock(tasks)}
}

func (s *Server) chatTaskShow(id string) []Block {
	if strings.TrimSpace(id) == "" {
		return []Block{TextBlock("Usage: show <id>")}
	}

	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	t, err := store.Get(resolved)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}

	var lines []string
	lines = append(lines, fmt.Sprintf("ID: %s", t.ID))
	lines = append(lines, fmt.Sprintf("Title: %s", t.Title))
	lines = append(lines, fmt.Sprintf("Description: %s", t.Description))
	lines = append(lines, fmt.Sprintf("Status: %s", t.Status))
	if t.AssignedTool != "" {
		lines = append(lines, fmt.Sprintf("Tool: %s", t.AssignedTool))
	} else {
		lines = append(lines, "Tool: (none)")
	}
	if t.Model != "" {
		lines = append(lines, fmt.Sprintf("Model: %s", t.Model))
	} else {
		lines = append(lines, "Model: (none)")
	}
	if len(t.DependsOn) > 0 {
		shortIDs := make([]string, 0, len(t.DependsOn))
		for _, dep := range t.DependsOn {
			if len(dep) >= 8 {
				shortIDs = append(shortIDs, dep[:8])
			} else {
				shortIDs = append(shortIDs, dep)
			}
		}
		lines = append(lines, "Dependencies: "+strings.Join(shortIDs, ", "))
	} else {
		lines = append(lines, "Dependencies: (none)")
	}
	lines = append(lines, "Plan:")
	if strings.TrimSpace(t.Plan) == "" {
		lines = append(lines, "(none)")
	} else {
		lines = append(lines, t.Plan)
	}

	return []Block{TextBlock(strings.Join(lines, "\n"))}
}

func (s *Server) chatTaskCreate(title string) []Block {
	if title == "" {
		return []Block{TextBlock("Usage: add <task title>")}
	}
	store := task.NewStore(s.db)
	t, err := store.Create(title, "", "", "")
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	s.hub.Broadcast(Event{Type: "task.created", Data: t})
	return []Block{TaskCardBlock(t)}
}

func (s *Server) chatTaskUpdate(id, rest string) []Block {
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	fields := make(map[string]interface{})
	if rest != "" {
		fields["title"] = rest
	}
	if len(fields) == 0 {
		return []Block{TextBlock("Nothing to update. Usage: edit <id> <new title>")}
	}
	if err := store.Update(resolved, fields); err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	t, _ := store.Get(resolved)
	s.hub.Broadcast(Event{Type: "task.updated", Data: t})
	return []Block{TaskCardBlock(t)}
}

func (s *Server) chatTaskDelete(id string) []Block {
	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	if err := store.Delete(resolved); err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	s.hub.Broadcast(Event{Type: "task.deleted", Data: map[string]string{"id": resolved}})
	return []Block{TextBlock(fmt.Sprintf("Deleted task %s", resolved[:8]))}
}

func (s *Server) chatTaskReopen(idsArg string) []Block {
	ids := strings.Fields(idsArg)
	if len(ids) == 0 {
		return []Block{TextBlock("Usage: reopen <id> [id...]")}
	}

	store := task.NewStore(s.db)
	var reopened []string
	var errors []string
	for _, prefix := range ids {
		resolved, err := store.ResolveID(prefix)
		if err != nil {
			errors = append(errors, fmt.Sprintf("Error: %v", err))
			continue
		}

		t, err := store.Get(resolved)
		if err != nil {
			errors = append(errors, fmt.Sprintf("Error: %v", err))
			continue
		}
		if t.Status != "failed" {
			errors = append(errors, fmt.Sprintf("Error: task %s is %q, not %q", resolved[:8], t.Status, "failed"))
			continue
		}
		if err := store.Update(resolved, map[string]interface{}{"status": "pending", "sprint_id": nil}); err != nil {
			errors = append(errors, fmt.Sprintf("Error: %v", err))
			continue
		}
		reopened = append(reopened, resolved)
	}

	var lines []string
	switch len(reopened) {
	case 0:
	case 1:
		lines = append(lines, fmt.Sprintf("Reopened task %s -> pending", reopened[0][:8]))
	default:
		lines = append(lines, fmt.Sprintf("Reopened %d tasks -> pending", len(reopened)))
	}
	lines = append(lines, errors...)
	if len(lines) == 0 {
		lines = append(lines, "No tasks were reopened.")
	}
	return []Block{TextBlock(strings.Join(lines, "\n"))}
}

func (s *Server) chatTaskPlan(id string) []Block {
	if strings.TrimSpace(id) == "" {
		return []Block{TextBlock("Usage: backlog plan <id>")}
	}

	store := task.NewStore(s.db)
	resolved, err := store.ResolveID(id)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	tk, err := store.Get(resolved)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}

	toolName := tk.AssignedTool
	if toolName == "" {
		for name := range s.cfg.Tools {
			toolName = name
			break
		}
	}
	if toolName == "" {
		return []Block{TextBlock("Error: no tools configured")}
	}

	toolCfg, ok := s.cfg.Tools[toolName]
	if !ok {
		return []Block{TextBlock(fmt.Sprintf("Error: tool %q not found", toolName))}
	}

	generator := planpkg.New(toolCfg, s.repoDir)
	var planContent string
	if tk.Model != "" {
		planContent, err = generator.GenerateWithModel(tk.Title, tk.Description, tk.Model)
	} else {
		planContent, err = generator.Generate(tk.Title, tk.Description)
	}
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: generate plan: %v", err))}
	}

	return []Block{TextBlock(planContent)}
}

func (s *Server) chatPlan(goal, sessionID string) []Block {
	if goal == "" {
		return []Block{TextBlock("Usage: plan <goal description>")}
	}

	var toolCfg config.ToolConfig
	for _, tc := range s.cfg.Tools {
		toolCfg = tc
		break
	}
	sid := sessionID
	if sid == "" {
		sid = "default"
	}

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "decompose",
		TargetID: sid,
		Status:   "running",
	}); err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: create decompose operation: %v", err))}
	}
	s.hub.Broadcast(Event{Type: "decompose.started", Data: map[string]string{"operation_id": opID}})

	go func() {
		// Auto-explore if no context exists.
		if explore.LoadContext(s.repoDir) == "" {
			s.hub.Broadcast(Event{Type: "plan.progress", Data: map[string]string{"message": "Exploring codebase..."}})
			explorer := explore.New(toolCfg, s.repoDir).WithGoal(goal)
			_, err := explorer.Run()
			if err != nil {
				if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
					log.Printf("mark decompose operation failed %s: %v", opID, opErr)
				}
				s.hub.Broadcast(Event{Type: "decompose.failed", Data: map[string]string{
					"operation_id": opID,
					"error":        err.Error(),
				}})
				s.hub.Broadcast(Event{Type: "plan.error", Data: map[string]string{"error": fmt.Sprintf("explore failed: %v", err)}})
				return
			}
		}

		// Decompose.
		s.hub.Broadcast(Event{Type: "plan.progress", Data: map[string]string{"message": "Decomposing goal into tasks..."}})
		d := decompose.New(toolCfg, s.repoDir)
		tasks, err := d.Run(goal)
		if err != nil {
			if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
				log.Printf("mark decompose operation failed %s: %v", opID, opErr)
			}
			s.hub.Broadcast(Event{Type: "decompose.failed", Data: map[string]string{
				"operation_id": opID,
				"error":        err.Error(),
			}})
			s.hub.Broadcast(Event{Type: "plan.error", Data: map[string]string{"error": fmt.Sprintf("decompose failed: %v", err)}})
			return
		}

		resultBytes, _ := json.Marshal(decomposeOperationResult{
			Goal:      goal,
			SessionID: sid,
			Proposed:  tasks,
		})
		if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
			log.Printf("complete decompose operation %s: %v", opID, err)
		}

		s.hub.Broadcast(Event{Type: "decompose.completed", Data: map[string]interface{}{
			"operation_id": opID,
			"proposed":     tasks,
		}})

		s.hub.Broadcast(Event{Type: "plan.proposed", Data: map[string]interface{}{
			"goal":         goal,
			"tasks":        tasks,
			"session_id":   sid,
			"proposal_id":  opID,
			"operation_id": opID,
		}})
	}()

	return []Block{TextBlock(fmt.Sprintf("Planning: %s...", goal))}
}

func (s *Server) chatPlanAccept(sessionID string) []Block {
	sid := sessionID
	if sid == "" {
		sid = "default"
	}

	op, result, err := s.findPendingDecomposeOperation(sid)
	if err == sql.ErrNoRows {
		return []Block{TextBlock("No pending plan to accept.")}
	}
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error loading pending plan: %v", err))}
	}

	createdIDs, err := s.createTasksFromProposed(result.Proposed)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error creating tasks: %v", err))}
	}
	result.Accepted = true
	result.CreatedTaskIDs = createdIDs
	result.Proposed = nil
	resultBytes, _ := json.Marshal(result)
	if err := s.ops.Complete(op.ID, string(resultBytes)); err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error finalizing accepted plan: %v", err))}
	}
	return []Block{TextBlock(fmt.Sprintf("Created %d tasks.", len(createdIDs)))}
}

func (s *Server) chatExplore() []Block {
	var toolCfg config.ToolConfig
	for _, tc := range s.cfg.Tools {
		toolCfg = tc
		break
	}

	go func() {
		explorer := explore.New(toolCfg, s.repoDir)
		outPath, err := explorer.Run()
		if err != nil {
			log.Printf("explore failed: %v", err)
			s.hub.Broadcast(Event{Type: "explore.failed", Data: map[string]string{"error": err.Error()}})
			return
		}
		log.Printf("explore completed: %s", outPath)
		s.hub.Broadcast(Event{Type: "explore.completed", Data: map[string]string{"path": outPath}})
	}()
	return []Block{TextBlock("Exploring codebase... Results will arrive via WebSocket.")}
}

func (s *Server) chatSprintPlan() []Block {
	active, err := s.planner.GetActive()
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	if active != nil {
		return []Block{TextBlock(fmt.Sprintf("Sprint %s already active (%s)", active.ID[:8], active.Status))}
	}

	sp, err := s.planner.Plan(s.cfg.Workers.MaxParallel)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}

	taskStatuses := make([]SprintTaskStatus, 0, len(sp.TaskIDs))
	for _, id := range sp.TaskIDs {
		t, _ := s.planner.GetTask(id)
		title := id[:8]
		toolName := ""
		if t != nil {
			title = t.Title
			toolName = t.AssignedTool
		}
		taskStatuses = append(taskStatuses, SprintTaskStatus{
			TaskID:   id,
			Title:    title,
			ToolName: toolName,
			Status:   "in_sprint",
		})
	}

	s.hub.Broadcast(Event{Type: "sprint.planned", Data: sp})
	return []Block{SprintProgressBlock(sp.ID, taskStatuses)}
}

func (s *Server) chatSprintStart() []Block {
	active, err := s.planner.GetActive()
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	if active == nil {
		return []Block{TextBlock("No active sprint. Run 'sprint plan' first.")}
	}
	if active.Status != "planning" {
		return []Block{TextBlock(fmt.Sprintf("Sprint %s is %s, not planning", active.ID[:8], active.Status))}
	}

	go func() {
		s.hub.Broadcast(Event{Type: "sprint.started", Data: map[string]string{"sprint_id": active.ID}})
		results, err := s.executor.Run(active)
		if err != nil {
			s.hub.Broadcast(Event{Type: "sprint.failed", Data: map[string]interface{}{"sprint_id": active.ID, "error": err.Error()}})
			return
		}
		s.hub.Broadcast(Event{Type: "sprint.completed", Data: map[string]interface{}{
			"sprint_id": active.ID,
			"results":   results,
		}})
	}()
	return []Block{TextBlock(fmt.Sprintf("Starting sprint %s... Results will arrive via WebSocket.", active.ID[:8]))}
}

func (s *Server) chatSprintStatus() []Block {
	active, err := s.planner.GetActive()
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	if active == nil {
		return []Block{TextBlock("No active sprint")}
	}

	taskStatuses := make([]SprintTaskStatus, 0, len(active.TaskIDs))
	for _, id := range active.TaskIDs {
		t, _ := s.planner.GetTask(id)
		title := id[:8]
		status := "unknown"
		toolName := ""
		if t != nil {
			title = t.Title
			status = t.Status
			toolName = t.AssignedTool
		}
		taskStatuses = append(taskStatuses, SprintTaskStatus{
			TaskID:   id,
			Title:    title,
			ToolName: toolName,
			Status:   status,
		})
	}

	return []Block{SprintProgressBlock(active.ID, taskStatuses)}
}

func (s *Server) chatSprintAssign(idsArg string) []Block {
	ids := strings.Fields(idsArg)
	if len(ids) == 0 {
		return []Block{TextBlock("Usage: sprint assign <id> [id...]")}
	}

	active, err := s.planner.GetActive()
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	if active == nil {
		active, err = s.planner.CreateEmpty()
		if err != nil {
			return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
		}
	}
	if active.Status != "planning" {
		return []Block{TextBlock("Error: sprint is running, cannot assign tasks")}
	}

	store := task.NewStore(s.db)
	var assigned []string
	var errors []string
	for _, prefix := range ids {
		resolved, err := store.ResolveID(prefix)
		if err != nil {
			errors = append(errors, fmt.Sprintf("Error: %v", err))
			continue
		}
		if err := s.planner.AddTaskToSprint(active.ID, resolved); err != nil {
			errors = append(errors, fmt.Sprintf("Error: %v", err))
			continue
		}
		assigned = append(assigned, resolved)
	}

	var lines []string
	switch len(assigned) {
	case 0:
	case 1:
		lines = append(lines, fmt.Sprintf("Assigned task %s to sprint %s (planning)", assigned[0][:8], active.ID[:8]))
	default:
		lines = append(lines, fmt.Sprintf("Assigned %d tasks to sprint %s (planning)", len(assigned), active.ID[:8]))
	}
	lines = append(lines, errors...)
	if len(lines) == 0 {
		lines = append(lines, "No tasks were assigned.")
	}
	return []Block{TextBlock(strings.Join(lines, "\n"))}
}

func (s *Server) chatSprintUnassign(idsArg string) []Block {
	ids := strings.Fields(idsArg)
	if len(ids) == 0 {
		return []Block{TextBlock("Usage: sprint unassign <id> [id...]")}
	}

	active, err := s.planner.GetActive()
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}
	if active == nil {
		return []Block{TextBlock("Error: no active sprint")}
	}
	if active.Status != "planning" {
		return []Block{TextBlock("Error: sprint is running, cannot unassign tasks")}
	}

	store := task.NewStore(s.db)
	var removed []string
	var errors []string
	for _, prefix := range ids {
		resolved, err := store.ResolveID(prefix)
		if err != nil {
			errors = append(errors, fmt.Sprintf("Error: %v", err))
			continue
		}
		if err := s.planner.RemoveTaskFromSprint(active.ID, resolved); err != nil {
			errors = append(errors, fmt.Sprintf("Error: %v", err))
			continue
		}
		removed = append(removed, resolved)
	}

	var lines []string
	switch len(removed) {
	case 0:
	case 1:
		lines = append(lines, fmt.Sprintf("Removed task %s from sprint %s", removed[0][:8], active.ID[:8]))
	default:
		lines = append(lines, fmt.Sprintf("Removed %d tasks from sprint %s", len(removed), active.ID[:8]))
	}
	lines = append(lines, errors...)
	if len(lines) == 0 {
		lines = append(lines, "No tasks were removed.")
	}
	return []Block{TextBlock(strings.Join(lines, "\n"))}
}

func (s *Server) chatSprintCancel() []Block {
	active, _ := s.planner.GetActive()
	if active == nil {
		return []Block{TextBlock("No active sprint to cancel")}
	}

	s.executor.Cancel()
	s.executor.Cleanup(active)
	s.planner.ResetSprintTasks(active.ID)
	s.planner.Fail(active.ID)

	s.hub.Broadcast(Event{Type: "sprint.cancelled", Data: map[string]string{"sprint_id": active.ID}})
	return []Block{TextBlock(fmt.Sprintf("Sprint %s cancelled. Tasks reverted to pending.", active.ID[:8]))}
}

func (s *Server) chatSprintReset() []Block {
	active, _ := s.planner.GetActive()
	if active == nil {
		// Try most recent sprint.
		var sprintID string
		err := s.db.QueryRow(`SELECT id FROM sprints ORDER BY created_at DESC LIMIT 1`).Scan(&sprintID)
		if err == sql.ErrNoRows {
			return []Block{TextBlock("No sprints to reset")}
		}
		sp, err := s.planner.Get(sprintID)
		if err != nil {
			return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
		}
		active = sp
	}

	s.executor.Cleanup(active)
	s.planner.ResetSprintTasks(active.ID)
	s.planner.Fail(active.ID)

	s.hub.Broadcast(Event{Type: "sprint.reset", Data: map[string]string{"sprint_id": active.ID}})
	return []Block{TextBlock(fmt.Sprintf("Sprint %s reset. Tasks reverted to pending.", active.ID[:8]))}
}

func (s *Server) chatReview() []Block {
	var sprintID string
	err := s.db.QueryRow(
		`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`,
	).Scan(&sprintID)
	if err == sql.ErrNoRows {
		return []Block{TextBlock("No completed sprints to review")}
	}
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}

	sp, err := s.planner.Get(sprintID)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}

	var blocks []Block
	for _, taskID := range sp.TaskIDs {
		t, _ := s.planner.GetTask(taskID)
		if t == nil || t.Status != "completed" {
			continue
		}

		var diff string
		s.db.QueryRow(`SELECT diff FROM artifacts WHERE task_id = ? AND sprint_id = ?`, taskID, sprintID).Scan(&diff)
		if diff == "" {
			continue
		}

		var files []string
		for _, line := range strings.Split(diff, "\n") {
			if strings.HasPrefix(line, "+++ b/") {
				files = append(files, strings.TrimPrefix(line, "+++ b/"))
			}
		}
		blocks = append(blocks, DiffViewerBlock(taskID, t.Title, diff, files))
	}

	if len(blocks) == 0 {
		return []Block{TextBlock("No diffs to review")}
	}
	return blocks
}

func (s *Server) chatAutoReview() []Block {
	return []Block{TextBlock("Running automated review... Results will arrive via WebSocket. Use the REST endpoint POST /api/v1/sprints/:id/review with {\"auto\": true} for full control.")}
}

func (s *Server) chatIntegrate() []Block {
	var sprintID string
	err := s.db.QueryRow(
		`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`,
	).Scan(&sprintID)
	if err == sql.ErrNoRows {
		return []Block{TextBlock("No completed sprints to integrate")}
	}

	sp, err := s.planner.Get(sprintID)
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: %v", err))}
	}

	var taskIDs []string
	for _, id := range sp.TaskIDs {
		t, _ := s.planner.GetTask(id)
		if t != nil && t.Status == "completed" {
			taskIDs = append(taskIDs, id)
		}
	}

	if len(taskIDs) == 0 {
		return []Block{TextBlock("No completed tasks to integrate")}
	}

	ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
	mergedIDs, failedIDs, _ := ig.MergeBatch(taskIDs)

	store := task.NewStore(s.db)
	for _, id := range mergedIDs {
		if err := store.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
			log.Printf("set task %s merged: %v", id, err)
			continue
		}
		if updated, err := store.Get(id); err == nil {
			s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
		}
	}

	toSummaries := func(ids []string) []TaskSummary {
		out := make([]TaskSummary, 0, len(ids))
		for _, id := range ids {
			title := id[:8]
			if t, _ := store.Get(id); t != nil {
				title = t.Title
			}
			out = append(out, TaskSummary{TaskID: id, Title: title})
		}
		return out
	}
	merged := toSummaries(mergedIDs)
	failed := toSummaries(failedIDs)

	s.hub.Broadcast(Event{Type: "integrate.completed", Data: map[string]interface{}{
		"merged": merged, "failed": failed,
	}})
	return []Block{IntegrateResultBlock(merged, failed)}
}

func (s *Server) chatCosts() []Block {
	ct := cost.NewTracker(s.db)
	projectTotal, _ := ct.ProjectTotal()
	summary, _ := ct.ProjectSummary()
	budget := s.cfg.Autopilot.CostBudget
	remaining, _ := ct.BudgetRemaining(budget)
	return []Block{CostCardBlock("Project", projectTotal, budget, remaining, summary)}
}

func (s *Server) chatConfig() []Block {
	return []Block{Block{Type: "config", Data: s.cfg}}
}

func (s *Server) chatCleanup() []Block {
	store := task.NewStore(s.db)
	wm := s.executor.Worktrees()

	worktreeList, err := wm.List()
	if err != nil {
		return []Block{TextBlock(fmt.Sprintf("Error: list worktrees: %v", err))}
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

	if len(stale) == 0 {
		return []Block{TextBlock("No stale worktrees found.")}
	}

	removed := 0
	var lines []string
	for _, st := range stale {
		if err := wm.Remove(st.taskID); err != nil {
			lines = append(lines, fmt.Sprintf("Failed: %s (%v)", st.branch, err))
			continue
		}
		removed++
		lines = append(lines, fmt.Sprintf("Removed: %s", st.branch))
	}
	lines = append(lines, fmt.Sprintf("Removed %d/%d stale worktrees.", removed, len(stale)))
	return []Block{TextBlock(strings.Join(lines, "\n"))}
}
