// Package review runs automated code review on task diffs using a headless LLM agent.
package review

import (
	"context"
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
}

type ReviewInput struct {
	TaskID      string `json:"task_id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Diff        string `json:"diff"`
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

func (r *Reviewer) Review(taskID, title, description, diff string) (*ReviewResult, error) {
	prompt := fmt.Sprintf(prompts.Review, title, description, diff)

	adapter := worker.NewAdapter(r.driver, r.model, r.timeout)

	var writer *interaction.Writer
	if r.interactions != nil {
		taskRef := taskID
		w, beginErr := r.interactions.Begin(&taskRef, "review", r.toolName)
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

	result, err := adapter.Execute(context.Background(), "review-"+taskID, prompt, r.repoDir)
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
			opts = append(opts, interaction.WithError(fmt.Sprintf("reviewer exited %d: %s", exitCode, stderr)))
		}
		_ = r.interactions.Finish(writer.ID(), status, opts...)
		_ = writer.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("execute reviewer: %w", err)
	}
	if exitCode != 0 {
		return nil, fmt.Errorf("reviewer exited %d: %s", exitCode, stderr)
	}

	output := stdout

	var resp reviewResponse
	if err := llm.ExtractJSON(output, &resp); err != nil {
		return nil, fmt.Errorf("parse review JSON: %w\nraw output:\n%s", err, output)
	}

	return &ReviewResult{TaskID: taskID, Approved: resp.Approved, Feedback: resp.Feedback, Tool: r.toolName}, nil
}

func (r *Reviewer) ReviewBatch(tasks []ReviewInput) ([]ReviewResult, error) {
	results := make([]ReviewResult, 0, len(tasks))
	for _, t := range tasks {
		res, err := r.Review(t.TaskID, t.Title, t.Description, t.Diff)
		if err != nil {
			results = append(results, ReviewResult{TaskID: t.TaskID, Approved: false, Feedback: fmt.Sprintf("review error: %v", err), Tool: r.toolName})
			continue
		}
		results = append(results, *res)
	}
	return results, nil
}
