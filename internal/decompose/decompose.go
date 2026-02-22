// Package decompose uses an LLM to break a goal into a structured task list.
package decompose

import (
	"context"
	"fmt"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/llm"
	"github.com/jasjeetmavi/pod/internal/worker"
	"github.com/jasjeetmavi/pod/prompts"
)

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

	prompt := fmt.Sprintf(prompts.Decompose, contextSection, goal)

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

	// Extract tool output based on configured output mode, then parse the task array.
	output := worker.ExtractOutput(d.toolCfg.Output, result.Stdout, d.repoDir)
	var tasks []ProposedTask
	if err := llm.ExtractJSON(output, &tasks); err != nil {
		return nil, fmt.Errorf("parse tasks JSON: %w\nraw output:\n%s", err, output)
	}
	return tasks, nil
}
