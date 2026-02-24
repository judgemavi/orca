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

	var writer *interaction.Writer
	interactionID := ""
	if d.interactions != nil {
		w, beginErr := d.interactions.Begin(taskID, "decompose", d.toolName)
		if beginErr == nil {
			writer = w
			interactionID = w.ID()
		}
	}
	var (
		outputCh   chan worker.OutputLine
		outputDone chan struct{}
	)
	if writer != nil {
		outputCh = make(chan worker.OutputLine, 256)
		outputDone = make(chan struct{})
		adapter.SetOutputChan(outputCh)
		go func() {
			defer close(outputDone)
			for line := range outputCh {
				if line.Stream == "raw" {
					_ = writer.WriteString(line.Line + "\n")
				}
			}
		}()
	}

	result, err := adapter.Execute(context.Background(), "decompose", prompt, d.repoDir)
	if outputCh != nil {
		close(outputCh)
		<-outputDone
	}
	stdout := ""
	exitCode := -1
	stderr := ""
	if result != nil {
		stdout = result.Stdout
		exitCode = result.ExitCode
		stderr = result.Stderr
	}
	if writer != nil {
		status := "completed"
		opts := []interaction.FinishOption{}
		if result != nil {
			opts = append(opts, interaction.WithCost(result.InputTokens, result.OutputTokens, result.TotalCost))
		}
		if err != nil {
			status = "failed"
			opts = append(opts, interaction.WithError(err.Error()))
		} else if exitCode != 0 {
			status = "failed"
			opts = append(opts, interaction.WithError(fmt.Sprintf("decomposer exited %d: %s", exitCode, stderr)))
		}
		_ = d.interactions.Finish(writer.ID(), status, opts...)
		_ = writer.Close()
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
