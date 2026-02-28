// Package plan generates markdown implementation plans for tasks using a headless LLM tool.
package plan

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/llm"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

// planResponse is the structured JSON response expected from the planner LLM.
type planResponse struct {
	Status string `json:"status"` // "completed" or "blocked"
	Plan   string `json:"plan"`
	Reason string `json:"reason"`
}

// Generator produces markdown implementation plans for tasks.
type Generator struct {
	toolName     string
	driver       driver.Driver
	model        string
	timeout      time.Duration
	repoDir      string
	interactions *interaction.Store
}

// New creates a plan Generator.
func New(toolName string, d driver.Driver, model string, timeout time.Duration, repoDir string, interactions ...*interaction.Store) *Generator {
	var store *interaction.Store
	if len(interactions) > 0 {
		store = interactions[0]
	}
	return &Generator{toolName: toolName, driver: d, model: model, timeout: timeout, repoDir: repoDir, interactions: store}
}

func (g *Generator) Generate(taskID, title, description string) (string, error) {
	return g.generate(taskID, title, description, "")
}

func (g *Generator) GenerateWithModel(taskID, title, description, model string) (string, error) {
	return g.generate(taskID, title, description, model)
}

func (g *Generator) generate(taskID, title, description, model string) (string, error) {
	prompt := buildPlanPrompt(explore.LoadContext(g.repoDir), title, description)
	selectedModel := g.model
	if model != "" {
		selectedModel = model
	}

	adapter := worker.NewAdapter(g.driver, selectedModel, g.timeout)
	var (
		stdout        string
		exitCode      = -1
		stderr        string
		generatedPlan string
		blocked       bool
		blockedReason string
	)
	taskRef := taskID
	_, err := interaction.RunWithTracking(
		g.interactions,
		&taskRef,
		"plan",
		g.toolName,
		adapter,
		func() (*worker.Result, error) {
			return adapter.Execute(context.Background(), "plan", prompt, g.repoDir)
		},
		interaction.WithAfterRun(func(result *worker.Result, _ error) {
			if result != nil {
				stdout = result.Stdout
				exitCode = result.ExitCode
				stderr = result.Stderr
			}
			generatedPlan, blocked, blockedReason = parsePlanResponse(stdout)
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
				opts = append(opts, interaction.WithError(fmt.Sprintf("planner exited %d: %s", exitCode, stderr)))
			} else if blocked {
				status = "failed"
				opts = append(opts, interaction.WithError(fmt.Sprintf("planner blocked: %s", blockedReason)))
			} else if generatedPlan != "" {
				opts = append(opts, interaction.WithDiff(generatedPlan))
			}
			return status, opts
		}),
	)
	if err != nil {
		return "", fmt.Errorf("execute planner: %w", err)
	}
	if exitCode != 0 {
		return "", fmt.Errorf("planner exited %d: %s", exitCode, stderr)
	}
	if blocked {
		return "", fmt.Errorf("planner blocked: %s", blockedReason)
	}
	return generatedPlan, nil
}

// parsePlanResponse attempts structured JSON extraction from planner output.
// Returns (plan, blocked, blockedReason). Falls back to raw text if no JSON found.
func parsePlanResponse(stdout string) (string, bool, string) {
	var resp planResponse
	if err := llm.ExtractJSON(stdout, &resp); err != nil {
		// Fallback: treat entire output as raw plan text (backwards compat).
		slog.Debug("plan: no structured JSON, falling back to raw text", "err", err)
		return strings.TrimSpace(stdout), false, ""
	}
	if strings.EqualFold(resp.Status, "blocked") {
		reason := resp.Reason
		if reason == "" {
			reason = "planner reported blocked with no reason"
		}
		return "", true, reason
	}
	plan := strings.TrimSpace(resp.Plan)
	if plan == "" {
		// JSON parsed but plan field empty — fall back to raw text.
		return strings.TrimSpace(stdout), false, ""
	}
	return plan, false, ""
}

func buildPlanPrompt(codebaseContext, title, description string) string {
	contextSection := ""
	if strings.TrimSpace(codebaseContext) != "" {
		contextSection = "## Codebase Context\n\n" + codebaseContext + "\n\n"
	}
	prompt := fmt.Sprintf(prompts.Plan, contextSection, title, description)
	return strings.TrimSpace(prompts.OutputStyle) + "\n\n---\n\n" + prompt
}
