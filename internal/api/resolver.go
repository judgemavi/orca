package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/worker"
)

const intentResolverPrompt = `You are a command interpreter for Pod, a multi-agent orchestrator.
Given the user's message, determine which command they want to run.

Available commands:
- models: List available models. Optional args: {"tool": "..."}
- status: Show project status
- task.list: List all tasks (aliases: backlog, tasks, show tasks)
- task.show: Show full task details. Args: {"id": "..."}
- task.create: Create a new task. Args: {"title": "...", "description": "..."}
- task.update: Edit a task. Args: {"id": "...", "title": "...", "tool": "..."}
- task.delete: Delete a task. Args: {"id": "..."}
- task.plan: Generate a plan for a task. Args: {"id": "..."}
- plan: Decompose a goal into tasks using LLM. Args: {"goal": "..."}. Also use this when the user wants to explore WITH a goal or create tasks for something specific.
- plan.accept: Accept/approve a pending plan
- explore: Analyze and map the codebase (no goal needed)
- sprint.plan: Plan the next sprint (select ready tasks)
- sprint.assign: Add task(s) to planning sprint. Args: {"ids": "id1 id2"}
- sprint.unassign: Remove task(s) from planning sprint. Args: {"ids": "id1 id2"}
- sprint.start: Start the planned sprint
- sprint.status: Check sprint progress
- sprint.cancel: Cancel running sprint
- sprint.reset: Reset sprint state
- task.reopen: Move failed task(s) back to pending. Args: {"ids": "id1 id2"}
- review: Review completed sprint diffs
- review.auto: Run automated LLM review
- integrate: Merge completed task branches
- costs: Show cost/budget summary
- config: Show configuration
- cleanup: Remove stale completed/failed task worktrees
- help: Show available commands

Respond with ONLY a JSON object:
{"action": "<command>", "args": {<optional key-value args>}}

If the user is making conversation or you can't determine a command, use:
{"action": "conversation", "args": {"message": "<your natural response>"}}`

type IntentResolver struct {
	toolCfg config.ToolConfig
	repoDir string
}

func NewIntentResolver(toolCfg config.ToolConfig, repoDir string) *IntentResolver {
	if strings.TrimSpace(toolCfg.Binary) == "" {
		return nil
	}
	tc := toolCfg
	tc.Timeout = "30s"
	return &IntentResolver{toolCfg: tc, repoDir: repoDir}
}

func (r *IntentResolver) Resolve(message string) (Intent, error) {
	if r == nil {
		return Intent{Action: "unknown", Args: map[string]string{"message": message}}, fmt.Errorf("resolver is nil")
	}

	prompt := intentResolverPrompt + "\n\nUser message:\n" + message

	adapter, err := worker.NewAdapter(r.toolCfg)
	if err != nil {
		return Intent{Action: "unknown", Args: map[string]string{"message": message}}, fmt.Errorf("create adapter: %w", err)
	}

	tmpDir, err := os.MkdirTemp("", "pod-intent-*")
	if err != nil {
		return Intent{Action: "unknown", Args: map[string]string{"message": message}}, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	result, err := adapter.Execute(context.Background(), "chat-intent", prompt, tmpDir)
	if err != nil {
		return Intent{Action: "unknown", Args: map[string]string{"message": message}}, fmt.Errorf("execute resolver: %w", err)
	}
	if result.ExitCode != 0 {
		return Intent{Action: "unknown", Args: map[string]string{"message": message}}, fmt.Errorf("resolver exited %d: %s", result.ExitCode, result.Stderr)
	}

	output := strings.TrimSpace(worker.ExtractClaudeResult(result.Stdout))
	intent, ok := parseIntentJSON(output)
	if !ok {
		log.Printf("chat intent parse fallback for message %q", message)
		return Intent{Action: "unknown", Args: map[string]string{"message": message}}, nil
	}

	if intent.Action == "" {
		intent.Action = "unknown"
	}
	if intent.Args == nil {
		intent.Args = map[string]string{}
	}
	normalizeIntentArgs(&intent)
	log.Printf("chat intent: %q -> %s", message, intent.Action)
	return intent, nil
}

func parseIntentJSON(output string) (Intent, bool) {
	type llmIntent struct {
		Action string                 `json:"action"`
		Args   map[string]interface{} `json:"args"`
	}

	decode := func(raw string) (Intent, bool) {
		var li llmIntent
		if err := json.Unmarshal([]byte(raw), &li); err != nil {
			return Intent{}, false
		}
		args := make(map[string]string, len(li.Args))
		for k, v := range li.Args {
			switch t := v.(type) {
			case string:
				args[k] = t
			case nil:
				args[k] = ""
			default:
				args[k] = fmt.Sprint(t)
			}
		}
		return Intent{Action: strings.TrimSpace(li.Action), Args: args}, true
	}

	if i, ok := decode(output); ok {
		return i, true
	}

	start := strings.Index(output, "{")
	end := strings.LastIndex(output, "}")
	if start >= 0 && end > start {
		return decode(output[start : end+1])
	}
	return Intent{}, false
}

func normalizeIntentArgs(intent *Intent) {
	if intent == nil {
		return
	}
	switch intent.Action {
	case "task.update":
		if intent.Args["rest"] == "" && intent.Args["title"] != "" {
			intent.Args["rest"] = intent.Args["title"]
		}
	case "task.create":
		if intent.Args["title"] == "" && intent.Args["description"] != "" {
			intent.Args["title"] = intent.Args["description"]
		}
	case "sprint.assign", "sprint.unassign", "task.reopen":
		if intent.Args["ids"] == "" && intent.Args["id"] != "" {
			intent.Args["ids"] = intent.Args["id"]
		}
	case "task.show", "task.plan":
		if intent.Args["id"] == "" && intent.Args["ids"] != "" {
			intent.Args["id"] = strings.Fields(intent.Args["ids"])[0]
		}
	}
}
