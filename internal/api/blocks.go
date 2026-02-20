package api

import (
	"github.com/jasjeetmavi/pod/internal/cost"
	"github.com/jasjeetmavi/pod/internal/decompose"
	"github.com/jasjeetmavi/pod/internal/task"
)

// Block is a typed UI element returned in chat responses.
type Block struct {
	Type string      `json:"type"`
	Data interface{} `json:"data,omitempty"`
}

// --- Block data types ---

type TaskCardData struct {
	Task    *task.Task `json:"task"`
	Actions []string   `json:"actions"`
}

type TaskListData struct {
	Tasks   []*task.Task `json:"tasks"`
	Actions []string     `json:"actions"`
}

type PlanProposalData struct {
	Goal          string                   `json:"goal"`
	ProposedTasks []decompose.ProposedTask `json:"proposed_tasks"`
	Actions       []string                 `json:"actions"`
}

type SprintTaskStatus struct {
	TaskID      string `json:"task_id"`
	Title       string `json:"title"`
	ToolName    string `json:"tool_name"`
	Status      string `json:"status"`
	DurationMs  int64  `json:"duration_ms"`
	ProgressPct int    `json:"progress_pct"`
}

type SprintProgressData struct {
	SprintID string             `json:"sprint_id"`
	Tasks    []SprintTaskStatus `json:"tasks"`
}

type TaskResultSummary struct {
	TaskID       string   `json:"task_id"`
	Title        string   `json:"title"`
	Status       string   `json:"status"`
	ToolName     string   `json:"tool_name"`
	DurationMs   int64    `json:"duration_ms"`
	FilesChanged []string `json:"files_changed"`
	DiffPreview  string   `json:"diff_preview"`
	HasFullDiff  bool     `json:"has_full_diff"`
}

type SprintResultData struct {
	SprintID string              `json:"sprint_id"`
	Results  []TaskResultSummary `json:"results"`
	Actions  []string            `json:"actions"`
}

type DiffViewerData struct {
	TaskID       string   `json:"task_id"`
	Title        string   `json:"title"`
	Diff         string   `json:"diff"`
	FilesChanged []string `json:"files_changed"`
	Actions      []string `json:"actions"`
}

type ReviewResultDisplay struct {
	TaskID   string `json:"task_id"`
	Title    string `json:"title"`
	Approved bool   `json:"approved"`
	Feedback string `json:"feedback"`
	Tool     string `json:"tool"`
}

type ReviewResultData struct {
	Reviews []ReviewResultDisplay `json:"reviews"`
	Actions []string              `json:"actions"`
}

type CostCardData struct {
	Scope     string             `json:"scope"`
	Total     float64            `json:"total"`
	Budget    float64            `json:"budget"`
	Remaining float64            `json:"remaining"`
	Tools     []cost.ToolSummary `json:"tools"`
}

type ProjectStatus struct {
	ProjectName     string         `json:"project_name"`
	TaskCounts      map[string]int `json:"task_counts"`
	ActiveSprint    interface{}    `json:"active_sprint"`
	ContextExists   bool           `json:"context_exists"`
	TotalCost       float64        `json:"total_cost"`
	Budget          float64        `json:"budget"`
	BudgetRemaining float64        `json:"budget_remaining"`
}

type TaskSummary struct {
	TaskID string `json:"task_id"`
	Title  string `json:"title"`
}

type IntegrateResultData struct {
	Merged []TaskSummary `json:"merged"`
	Failed []TaskSummary `json:"failed"`
}

type EscalationData struct {
	Message string   `json:"message"`
	TaskID  string   `json:"task_id,omitempty"`
	Actions []string `json:"actions"`
}

// --- Block builders ---

func TextBlock(content string) Block {
	return Block{Type: "text", Data: map[string]string{"content": content}}
}

func TaskCardBlock(t *task.Task) Block {
	return Block{Type: "task_card", Data: TaskCardData{
		Task:    t,
		Actions: []string{"edit", "delete", "assign_tool"},
	}}
}

func TaskListBlock(tasks []*task.Task) Block {
	return Block{Type: "task_list", Data: TaskListData{
		Tasks:   tasks,
		Actions: []string{"plan", "add task"},
	}}
}

func PlanProposalBlock(goal string, tasks []decompose.ProposedTask) Block {
	return Block{Type: "plan_proposal", Data: PlanProposalData{
		Goal:          goal,
		ProposedTasks: tasks,
		Actions:       []string{"Approve", "Reject"},
	}}
}

func SprintProgressBlock(sprintID string, tasks []SprintTaskStatus) Block {
	return Block{Type: "sprint_progress", Data: SprintProgressData{SprintID: sprintID, Tasks: tasks}}
}

func SprintResultBlock(sprintID string, results []TaskResultSummary) Block {
	return Block{Type: "sprint_result", Data: SprintResultData{
		SprintID: sprintID,
		Results:  results,
		Actions:  []string{"review", "integrate"},
	}}
}

func DiffViewerBlock(taskID, title, diff string, files []string) Block {
	return Block{Type: "diff_viewer", Data: DiffViewerData{
		TaskID:       taskID,
		Title:        title,
		Diff:         diff,
		FilesChanged: files,
		Actions:      []string{"approve", "reject"},
	}}
}

func ReviewResultBlock(reviews []ReviewResultDisplay) Block {
	return Block{Type: "review_result", Data: ReviewResultData{
		Reviews: reviews,
		Actions: []string{"integrate"},
	}}
}

func CostCardBlock(scope string, total, budget, remaining float64, tools []cost.ToolSummary) Block {
	return Block{Type: "cost_card", Data: CostCardData{
		Scope:     scope,
		Total:     total,
		Budget:    budget,
		Remaining: remaining,
		Tools:     tools,
	}}
}

func StatusCardBlock(status ProjectStatus) Block {
	return Block{Type: "status_card", Data: status}
}

func EscalationBlock(message, taskID string) Block {
	return Block{Type: "escalation", Data: EscalationData{
		Message: message,
		TaskID:  taskID,
		Actions: []string{"retry", "abort"},
	}}
}

func IntegrateResultBlock(merged, failed []TaskSummary) Block {
	return Block{Type: "integrate_result", Data: IntegrateResultData{Merged: merged, Failed: failed}}
}

func HelpBlock() Block {
	return Block{Type: "help", Data: map[string]interface{}{
		"commands": []map[string]string{
			{"command": "models [tool]", "description": "List available models"},
			{"command": "status", "description": "Show project status"},
			{"command": "backlog / tasks", "description": "List all tasks"},
			{"command": "show <id>", "description": "Show full task details"},
			{"command": "add <title>", "description": "Create a new task"},
			{"command": "edit <id> ...", "description": "Edit a task"},
			{"command": "delete <id>", "description": "Delete a task"},
			{"command": "backlog plan <id>", "description": "Generate a task implementation plan"},
			{"command": "plan <goal>", "description": "Decompose goal into tasks"},
			{"command": "approve", "description": "Accept proposed plan"},
			{"command": "explore", "description": "Analyze codebase"},
			{"command": "sprint plan", "description": "Plan next sprint"},
			{"command": "sprint assign <id>", "description": "Add task to sprint"},
			{"command": "sprint unassign <id>", "description": "Remove task from sprint"},
			{"command": "start / run", "description": "Start sprint execution"},
			{"command": "sprint status", "description": "Check sprint progress"},
			{"command": "cancel", "description": "Cancel running sprint"},
			{"command": "reset", "description": "Reset sprint"},
			{"command": "backlog reopen <id>", "description": "Move failed task to pending"},
			{"command": "review", "description": "Review sprint results"},
			{"command": "auto review", "description": "Run automated LLM review"},
			{"command": "integrate / merge", "description": "Merge completed tasks"},
			{"command": "costs / budget", "description": "Show cost summary"},
			{"command": "config / settings", "description": "Show configuration"},
			{"command": "cleanup", "description": "Remove stale completed/failed task worktrees"},
			{"command": "autopilot <goal>", "description": "Run autonomous loop"},
			{"command": "stop", "description": "Stop autopilot"},
			{"command": "help", "description": "Show this help"},
		},
	}}
}
