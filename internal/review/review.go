// Package review runs automated code review on task diffs using a headless LLM agent.
package review

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/worker"
	"github.com/jasjeetmavi/pod/prompts"
)

// ReviewResult holds the outcome of a single task review.
type ReviewResult struct {
	TaskID   string `json:"task_id"`
	Approved bool   `json:"approved"`
	Feedback string `json:"feedback"`
	Tool     string `json:"tool"`
}

// ReviewInput is the data needed to review a single task.
type ReviewInput struct {
	TaskID      string `json:"task_id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Diff        string `json:"diff"`
}

// Reviewer runs headless code reviews against diffs.
type Reviewer struct {
	toolCfg config.ToolConfig
	repoDir string
}

// New creates a Reviewer with the given tool config and repo directory.
func New(toolCfg config.ToolConfig, repoDir string) *Reviewer {
	return &Reviewer{toolCfg: toolCfg, repoDir: repoDir}
}

// reviewResponse is the JSON shape we expect from the LLM.
type reviewResponse struct {
	Approved bool   `json:"approved"`
	Feedback string `json:"feedback"`
}

// Review runs a code review on a single task diff.
func (r *Reviewer) Review(taskID, title, description, diff string) (*ReviewResult, error) {
	prompt := fmt.Sprintf(prompts.Review, title, description, diff)

	adapter, err := worker.NewAdapter(r.toolCfg)
	if err != nil {
		return nil, fmt.Errorf("create adapter: %w", err)
	}

	result, err := adapter.Execute(context.Background(), "review-"+taskID, prompt, r.repoDir)
	if err != nil {
		return nil, fmt.Errorf("execute reviewer: %w", err)
	}

	if result.ExitCode != 0 {
		return nil, fmt.Errorf("reviewer exited %d: %s", result.ExitCode, result.Stderr)
	}

	var resp reviewResponse
	output := result.Stdout
	if err := json.Unmarshal([]byte(output), &resp); err != nil {
		// Try to extract JSON object from surrounding text.
		start := -1
		depth := 0
		for i, c := range output {
			if c == '{' && start == -1 {
				start = i
				depth = 1
			} else if c == '{' && start != -1 {
				depth++
			} else if c == '}' && start != -1 {
				depth--
				if depth == 0 {
					if err2 := json.Unmarshal([]byte(output[start:i+1]), &resp); err2 == nil {
						return &ReviewResult{
							TaskID:   taskID,
							Approved: resp.Approved,
							Feedback: resp.Feedback,
							Tool:     r.toolCfg.Binary,
						}, nil
					}
				}
			}
		}
		return nil, fmt.Errorf("parse review JSON: %w\nraw output:\n%s", err, output)
	}

	return &ReviewResult{
		TaskID:   taskID,
		Approved: resp.Approved,
		Feedback: resp.Feedback,
		Tool:     r.toolCfg.Binary,
	}, nil
}

// ReviewBatch reviews multiple tasks sequentially.
func (r *Reviewer) ReviewBatch(tasks []ReviewInput) ([]ReviewResult, error) {
	results := make([]ReviewResult, 0, len(tasks))
	for _, t := range tasks {
		res, err := r.Review(t.TaskID, t.Title, t.Description, t.Diff)
		if err != nil {
			results = append(results, ReviewResult{
				TaskID:   t.TaskID,
				Approved: false,
				Feedback: fmt.Sprintf("review error: %v", err),
				Tool:     r.toolCfg.Binary,
			})
			continue
		}
		results = append(results, *res)
	}
	return results, nil
}
