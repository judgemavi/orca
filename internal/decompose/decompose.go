// Package decompose uses an LLM to break a goal into a structured task list.
package decompose

import (
	"context"
	"fmt"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/llm"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

type ProposedTask struct {
	Title            string `json:"title"`
	Description      string `json:"description"`
	DependsOnIndices []int  `json:"depends_on_indices"`
	SuggestedTool    string `json:"suggested_tool"`
}

type Decomposer struct {
	toolName     string
	driver       driver.Driver
	model        string
	timeout      time.Duration
	repoDir      string
	interactions *interaction.Store
}

func New(toolName string, d driver.Driver, model string, timeout time.Duration, repoDir string, interactions ...*interaction.Store) *Decomposer {
	var store *interaction.Store
	if len(interactions) > 0 {
		store = interactions[0]
	}
	return &Decomposer{toolName: toolName, driver: d, model: model, timeout: timeout, repoDir: repoDir, interactions: store}
}

func (d *Decomposer) Run(taskID *string, goal string) ([]ProposedTask, string, error) {
	contextSection := ""
	if ctx := explore.LoadContext(d.repoDir); ctx != "" {
		contextSection = "## Codebase Context\n\n" + ctx + "\n\n"
	}
	prompt := fmt.Sprintf(prompts.Decompose, contextSection, goal)

	adapter := worker.NewAdapter(d.driver, d.model, d.timeout)

	interactionID := ""
	result, err := interaction.RunWithTracking(
		d.interactions,
		taskID,
		"decompose",
		d.toolName,
		adapter,
		func() (*worker.Result, error) {
			return adapter.Execute(context.Background(), "decompose", prompt, d.repoDir)
		},
		interaction.WithOnBegin(func(w *interaction.Writer) {
			interactionID = w.ID()
		}),
		interaction.WithFinishFn(func(result *worker.Result, runErr error) (string, []interaction.FinishOption) {
			status := "completed"
			opts := []interaction.FinishOption{}
			if result != nil {
				opts = append(opts, interaction.WithCost(result.InputTokens, result.OutputTokens, result.TotalCost))
			}
			if runErr != nil {
				status = "failed"
				opts = append(opts, interaction.WithError(runErr.Error()))
			} else if result == nil || result.ExitCode != 0 {
				status = "failed"
				exitCode := -1
				stderr := ""
				if result != nil {
					exitCode = result.ExitCode
					stderr = result.Stderr
				}
				opts = append(opts, interaction.WithError(fmt.Sprintf("decomposer exited %d: %s", exitCode, stderr)))
			}
			return status, opts
		}),
	)
	stdout := ""
	exitCode := -1
	stderr := ""
	if result != nil {
		stdout = result.Stdout
		exitCode = result.ExitCode
		stderr = result.Stderr
	}
	if err != nil {
		return nil, interactionID, fmt.Errorf("execute decomposer: %w", err)
	}
	if exitCode != 0 {
		return nil, interactionID, fmt.Errorf("decomposer exited %d: %s", exitCode, stderr)
	}

	output := stdout
	var tasks []ProposedTask
	if err := llm.ExtractJSON(output, &tasks); err != nil {
		return nil, interactionID, fmt.Errorf("parse tasks JSON: %w\nraw output:\n%s", err, output)
	}
	return tasks, interactionID, nil
}
