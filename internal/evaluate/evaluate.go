// Package evaluate determines whether a task needs decomposition into subtasks.
package evaluate

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/llm"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

type EvaluationResult struct {
	NeedsBreakdown        bool    `json:"needs_breakdown"`
	Confidence            float64 `json:"confidence"`
	Reasoning             string  `json:"reasoning"`
	SuggestedSubtaskCount int     `json:"suggested_subtask_count"`
}

type Evaluator struct {
	toolName     string
	driver       driver.Driver
	model        string
	timeout      time.Duration
	repoDir      string
	interactions *interaction.Store
}

func New(toolName string, d driver.Driver, model string, timeout time.Duration, repoDir string, interactions ...*interaction.Store) *Evaluator {
	var store *interaction.Store
	if len(interactions) > 0 {
		store = interactions[0]
	}
	return &Evaluator{toolName: toolName, driver: d, model: model, timeout: timeout, repoDir: repoDir, interactions: store}
}

func (e *Evaluator) Evaluate(taskID, title, description string) (*EvaluationResult, error) {
	return e.evaluate(taskID, title, description, "")
}

func (e *Evaluator) EvaluateWithModel(taskID, title, description, model string) (*EvaluationResult, error) {
	return e.evaluate(taskID, title, description, model)
}

func (e *Evaluator) evaluate(taskID, title, description, model string) (*EvaluationResult, error) {
	prompt := buildEvaluatePrompt(explore.LoadContext(e.repoDir), title, description)
	selectedModel := e.model
	if model != "" {
		selectedModel = model
	}

	adapter := worker.NewAdapter(e.driver, selectedModel, e.timeout)

	var writer *interaction.Writer
	if e.interactions != nil {
		taskRef := taskID
		w, beginErr := e.interactions.Begin(&taskRef, "evaluate", e.toolName)
		if beginErr == nil {
			writer = w
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

	result, err := adapter.Execute(context.Background(), "evaluate", prompt, e.repoDir)
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
	output := stdout
	evaluationResult := &EvaluationResult{NeedsBreakdown: false}
	parseErr := llm.ExtractJSON(output, evaluationResult)

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
			opts = append(opts, interaction.WithError(fmt.Sprintf("evaluator exited %d: %s", exitCode, stderr)))
		} else {
			if parseErr != nil {
				evaluationResult = &EvaluationResult{NeedsBreakdown: false}
			}
			qualityBytes, _ := json.Marshal(evaluationResult)
			opts = append(opts, interaction.WithQuality(string(qualityBytes)))
		}
		_ = e.interactions.Finish(writer.ID(), status, opts...)
		_ = writer.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("execute evaluator: %w", err)
	}
	if exitCode != 0 {
		return nil, fmt.Errorf("evaluator exited %d: %s", exitCode, stderr)
	}

	if parseErr != nil {
		return &EvaluationResult{NeedsBreakdown: false}, nil
	}

	return evaluationResult, nil
}

func buildEvaluatePrompt(codebaseContext, title, description string) string {
	contextSection := ""
	if strings.TrimSpace(codebaseContext) != "" {
		contextSection = "## Codebase Context\n\n" + codebaseContext + "\n\n"
	}
	return fmt.Sprintf(prompts.Evaluate, contextSection, title, description)
}
