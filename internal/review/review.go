// Package review runs automated code review on task diffs using a headless LLM agent.
package review

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/llm"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

type ReviewResult struct {
	TaskID   string `json:"task_id"`
	Approved bool   `json:"approved"`
	Feedback string `json:"feedback"`
	Tool     string `json:"tool"`
	Prompt   string `json:"prompt,omitempty"`
}

type Reviewer struct {
	toolName     string
	driver       driver.Driver
	model        string
	timeout      time.Duration
	repoDir      string
	interactions *interaction.Store
}

func New(toolName string, d driver.Driver, model string, timeout time.Duration, repoDir string, interactions ...*interaction.Store) *Reviewer {
	var store *interaction.Store
	if len(interactions) > 0 {
		store = interactions[0]
	}
	return &Reviewer{toolName: toolName, driver: d, model: model, timeout: timeout, repoDir: repoDir, interactions: store}
}

type reviewResponse struct {
	Approved bool   `json:"approved"`
	Feedback string `json:"feedback"`
}

func (r *Reviewer) Review(taskID, title, description, diff, userPrompt string) (*ReviewResult, error) {
	instructions := "No additional instructions."
	if userPrompt != "" {
		instructions = userPrompt
	}
	prompt := fmt.Sprintf(prompts.Review, title, description, diff, instructions)

	adapter := worker.NewAdapter(r.driver, r.model, r.timeout)
	var (
		stdout       string
		exitCode     = -1
		stderr       string
		reviewResult *ReviewResult
		parseErr     error
	)
	taskRef := taskID
	_, err := interaction.RunWithTracking(
		r.interactions,
		&taskRef,
		"review",
		r.toolName,
		adapter,
		func() (*worker.Result, error) {
			return adapter.Execute(context.Background(), "review-"+taskID, prompt, r.repoDir)
		},
		interaction.WithAfterRun(func(result *worker.Result, runErr error) {
			if result != nil {
				stdout = result.Stdout
				exitCode = result.ExitCode
				stderr = result.Stderr
			}
			if runErr == nil && exitCode == 0 {
				var resp reviewResponse
				if parseErr = llm.ExtractJSON(stdout, &resp); parseErr == nil {
					reviewResult = &ReviewResult{TaskID: taskID, Approved: resp.Approved, Feedback: resp.Feedback, Tool: r.toolName, Prompt: userPrompt}
				}
			}
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
				opts = append(opts, interaction.WithError(fmt.Sprintf("reviewer exited %d: %s", exitCode, stderr)))
			} else if parseErr != nil {
				status = "failed"
				opts = append(opts, interaction.WithError(fmt.Sprintf("parse review JSON: %v", parseErr)))
			} else if reviewResult != nil {
				qualityBytes, _ := json.Marshal(reviewResult)
				opts = append(opts, interaction.WithQuality(string(qualityBytes)))
			}
			return status, opts
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("execute reviewer: %w", err)
	}
	if exitCode != 0 {
		return nil, fmt.Errorf("reviewer exited %d: %s", exitCode, stderr)
	}
	if parseErr != nil {
		return nil, fmt.Errorf("parse review JSON: %w\nraw output:\n%s", parseErr, stdout)
	}

	return reviewResult, nil
}
