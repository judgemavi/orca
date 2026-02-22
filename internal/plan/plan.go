// Package plan generates markdown implementation plans for tasks using a headless LLM tool.
package plan

import (
	"context"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/worker"
	"github.com/jasjeetmavi/pod/prompts"
)

// Generator produces markdown implementation plans for tasks.
type Generator struct {
	toolCfg config.ToolConfig
	repoDir string
}

// New creates a plan Generator.
func New(toolCfg config.ToolConfig, repoDir string) *Generator {
	return &Generator{toolCfg: toolCfg, repoDir: repoDir}
}

// Generate creates an implementation plan for a task.
func (g *Generator) Generate(title, description string) (string, error) {
	return g.generate(title, description, "")
}

// GenerateWithModel creates a plan using a specific model override.
func (g *Generator) GenerateWithModel(title, description, model string) (string, error) {
	return g.generate(title, description, model)
}

func (g *Generator) generate(title, description, model string) (string, error) {
	prompt := buildPlanPrompt(explore.LoadContext(g.repoDir), title, description)

	toolCfg := applyModelOverride(g.toolCfg, model)

	adapter, err := worker.NewAdapter(toolCfg)
	if err != nil {
		return "", fmt.Errorf("create adapter: %w", err)
	}

	result, err := adapter.Execute(context.Background(), "plan", prompt, g.repoDir)
	if err != nil {
		return "", fmt.Errorf("execute planner: %w", err)
	}
	if result.ExitCode != 0 {
		return "", fmt.Errorf("planner exited %d: %s", result.ExitCode, result.Stderr)
	}

	return extractPlanOutput(result.Stdout, toolCfg.Output, g.repoDir), nil
}

func buildPlanPrompt(codebaseContext, title, description string) string {
	contextSection := ""
	if strings.TrimSpace(codebaseContext) != "" {
		contextSection = "## Codebase Context\n\n" + codebaseContext + "\n\n"
	}
	return fmt.Sprintf(prompts.Plan, contextSection, title, description)
}

func extractPlanOutput(stdout string, outputCfg config.ToolOutputConfig, worktreePath string) string {
	return strings.TrimSpace(worker.ExtractOutput(outputCfg, stdout, worktreePath))
}

func applyModelOverride(toolCfg config.ToolConfig, model string) config.ToolConfig {
	if model != "" {
		toolCfg.Model = model
	}
	return toolCfg
}
