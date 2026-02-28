// Package evaluate determines whether a task needs breakdown into subtasks.
package evaluate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	DescriptionHash       string  `json:"description_hash"`
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
	descriptionHash := taskDescriptionHash(title, description)
	selectedModel := e.model
	if model != "" {
		selectedModel = model
	}

	adapter := worker.NewAdapter(e.driver, selectedModel, e.timeout)
	var (
		exitCode         = -1
		stderr           string
		output           string
		evaluationResult = &EvaluationResult{NeedsBreakdown: false}
		parseErr         error
	)
	taskRef := taskID
	_, err := interaction.RunWithTracking(
		e.interactions,
		&taskRef,
		interaction.PhaseEvaluate,
		e.toolName,
		adapter,
		func() (*worker.Result, error) {
			return adapter.Execute(context.Background(), interaction.PhaseEvaluate, prompt, e.repoDir)
		},
		interaction.WithAfterRun(func(result *worker.Result, _ error) {
			if result != nil {
				output = result.Stdout
				exitCode = result.ExitCode
				stderr = result.Stderr
			}
			parseErr = llm.ExtractJSON(output, evaluationResult)
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
			} else if exitCode != 0 {
				status = "failed"
				opts = append(opts, interaction.WithError(fmt.Sprintf("evaluator exited %d: %s", exitCode, stderr)))
			} else {
				if parseErr != nil {
					evaluationResult = &EvaluationResult{NeedsBreakdown: false, DescriptionHash: descriptionHash}
				} else {
					evaluationResult.DescriptionHash = descriptionHash
				}
				qualityBytes, _ := json.Marshal(evaluationResult)
				opts = append(opts, interaction.WithQuality(string(qualityBytes)))
			}
			return status, opts
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("execute evaluator: %w", err)
	}
	if exitCode != 0 {
		return nil, fmt.Errorf("evaluator exited %d: %s", exitCode, stderr)
	}

	if parseErr != nil {
		return &EvaluationResult{NeedsBreakdown: false, DescriptionHash: descriptionHash}, nil
	}

	evaluationResult.DescriptionHash = descriptionHash
	return evaluationResult, nil
}

func buildEvaluatePrompt(codebaseContext, title, description string) string {
	contextSection := ""
	if strings.TrimSpace(codebaseContext) != "" {
		contextSection = "## Codebase Context\n\n" + codebaseContext + "\n\n"
	}
	return fmt.Sprintf(prompts.Evaluate, contextSection, title, description)
}

func taskDescriptionHash(title, description string) string {
	sum := sha256.Sum256([]byte(title + "\n" + description))
	return hex.EncodeToString(sum[:])
}
