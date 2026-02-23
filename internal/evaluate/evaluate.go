// Package evaluate determines whether a task needs decomposition into subtasks.
package evaluate

import (
	"context"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/llm"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

// EvaluationResult captures evaluator output for task decomposition decisions.
type EvaluationResult struct {
	NeedsBreakdown        bool    `json:"needs_breakdown"`
	Confidence            float64 `json:"confidence"`
	Reasoning             string  `json:"reasoning"`
	SuggestedSubtaskCount int     `json:"suggested_subtask_count"`
}

// Evaluator determines whether tasks should be decomposed into subtasks.
type Evaluator struct {
	toolCfg config.ToolConfig
	repoDir string
}

// New creates a task Evaluator.
func New(toolCfg config.ToolConfig, repoDir string) *Evaluator {
	return &Evaluator{toolCfg: toolCfg, repoDir: repoDir}
}

// Evaluate decides whether a task needs decomposition.
func (e *Evaluator) Evaluate(title, description string) (*EvaluationResult, error) {
	return e.evaluate(title, description, "")
}

// EvaluateWithModel decides whether a task needs decomposition using a model override.
func (e *Evaluator) EvaluateWithModel(title, description, model string) (*EvaluationResult, error) {
	return e.evaluate(title, description, model)
}

func (e *Evaluator) evaluate(title, description, model string) (*EvaluationResult, error) {
	prompt := buildEvaluatePrompt(explore.LoadContext(e.repoDir), title, description)

	toolCfg := applyModelOverride(e.toolCfg, model)

	adapter, err := worker.NewAdapter(toolCfg)
	if err != nil {
		return nil, fmt.Errorf("create adapter: %w", err)
	}

	result, err := adapter.Execute(context.Background(), "evaluate", prompt, e.repoDir)
	if err != nil {
		return nil, fmt.Errorf("execute evaluator: %w", err)
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("evaluator exited %d: %s", result.ExitCode, result.Stderr)
	}

	output := worker.ExtractOutput(toolCfg.Output, result.Stdout, e.repoDir)

	var evaluationResult EvaluationResult
	if err := llm.ExtractJSON(output, &evaluationResult); err != nil {
		return &EvaluationResult{NeedsBreakdown: false}, nil
	}

	return &evaluationResult, nil
}

func buildEvaluatePrompt(codebaseContext, title, description string) string {
	contextSection := ""
	if strings.TrimSpace(codebaseContext) != "" {
		contextSection = "## Codebase Context\n\n" + codebaseContext + "\n\n"
	}
	return fmt.Sprintf(prompts.Evaluate, contextSection, title, description)
}

func applyModelOverride(toolCfg config.ToolConfig, model string) config.ToolConfig {
	if model != "" {
		toolCfg.Model = model
	}
	return toolCfg
}
