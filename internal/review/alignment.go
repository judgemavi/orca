package review

import (
	"context"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/llm"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

type alignmentResponse struct {
	Aligned bool   `json:"aligned"`
	Reason  string `json:"reason"`
}

type AlignmentResult struct {
	TaskID  string `json:"task_id"`
	Aligned bool   `json:"aligned"`
	Reason  string `json:"reason"`
}

// CheckAlignment verifies that a diff actually implements the described task.
// Uses a cheap LLM call intended for lower-cost model tiers.
func (r *Reviewer) CheckAlignment(taskID, title, description, diff string) (*AlignmentResult, error) {
	if strings.TrimSpace(diff) == "" {
		return &AlignmentResult{
			TaskID:  taskID,
			Aligned: false,
			Reason:  "empty diff",
		}, nil
	}

	prompt := fmt.Sprintf(prompts.Alignment, title, description, diff)

	adapter, err := worker.NewAdapter(r.toolCfg)
	if err != nil {
		return nil, fmt.Errorf("create adapter: %w", err)
	}

	result, err := adapter.Execute(context.Background(), "alignment-"+taskID, prompt, r.repoDir)
	if err != nil {
		return nil, fmt.Errorf("execute alignment checker: %w", err)
	}

	if result.ExitCode != 0 {
		return nil, fmt.Errorf("alignment checker exited %d: %s", result.ExitCode, result.Stderr)
	}

	var resp alignmentResponse
	output := result.Stdout
	if err := llm.ExtractJSON(output, &resp); err != nil {
		return nil, fmt.Errorf("parse alignment JSON: %w\nraw output:\n%s", err, output)
	}

	return &AlignmentResult{
		TaskID:  taskID,
		Aligned: resp.Aligned,
		Reason:  resp.Reason,
	}, nil
}
