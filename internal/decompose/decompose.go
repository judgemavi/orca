// Package decompose uses an LLM to break a goal into a structured task list.
package decompose

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/worker"
)

const promptTemplate = `You are a task decomposer for a software project. Given a goal, break it into concrete, implementable tasks.

%s
## Goal

%s

## Instructions

Respond with ONLY a JSON array. Each element:
{
  "title": "short imperative title",
  "description": "what to implement, specific files/functions if known",
  "depends_on_indices": [0, 1],
  "suggested_tool": "claude"
}

depends_on_indices uses 0-based indices into this array. Leave empty if no deps.
suggested_tool is optional — use "claude", "codex", or "" if no preference.

Keep tasks small and parallelizable. Aim for 2-8 tasks.`

// ProposedTask is a task proposed by the LLM decomposer.
type ProposedTask struct {
	Title            string `json:"title"`
	Description      string `json:"description"`
	DependsOnIndices []int  `json:"depends_on_indices"`
	SuggestedTool    string `json:"suggested_tool"`
}

// Decomposer wraps a tool config to decompose goals into tasks.
type Decomposer struct {
	toolCfg config.ToolConfig
	repoDir string
}

// New creates a Decomposer.
func New(toolCfg config.ToolConfig, repoDir string) *Decomposer {
	return &Decomposer{toolCfg: toolCfg, repoDir: repoDir}
}

// Run decomposes a goal into proposed tasks.
func (d *Decomposer) Run(goal string) ([]ProposedTask, error) {
	contextSection := ""
	if ctx := explore.LoadContext(d.repoDir); ctx != "" {
		contextSection = "## Codebase Context\n\n" + ctx + "\n\n"
	}

	prompt := fmt.Sprintf(promptTemplate, contextSection, goal)

	adapter, err := worker.NewAdapter(d.toolCfg)
	if err != nil {
		return nil, fmt.Errorf("create adapter: %w", err)
	}

	result, err := adapter.Execute(context.Background(), "decompose", prompt, d.repoDir)
	if err != nil {
		return nil, fmt.Errorf("execute decomposer: %w", err)
	}

	if result.ExitCode != 0 {
		return nil, fmt.Errorf("decomposer exited %d: %s", result.ExitCode, result.Stderr)
	}

	// Unwrap Claude JSON envelope if present, then parse the task array.
	output := worker.ExtractClaudeResult(result.Stdout)
	var tasks []ProposedTask
	if err := json.Unmarshal([]byte(output), &tasks); err != nil {
		// Try to extract JSON array from surrounding text.
		start := -1
		depth := 0
		for i, c := range output {
			if c == '[' && start == -1 {
				start = i
				depth = 1
			} else if c == '[' && start != -1 {
				depth++
			} else if c == ']' && start != -1 {
				depth--
				if depth == 0 {
					if err2 := json.Unmarshal([]byte(output[start:i+1]), &tasks); err2 == nil {
						return tasks, nil
					}
				}
			}
		}
		return nil, fmt.Errorf("parse tasks JSON: %w\nraw output:\n%s", err, output)
	}
	return tasks, nil
}
