package review

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/pod/internal/worker"
)

const alignmentPromptTemplate = `You are a task alignment checker. Given a task description and a code diff, determine if the diff actually implements what was requested.

## Task
Title: %s
Description: %s

## Diff
%s

## Instructions
Respond with JSON only:
{"aligned": true/false, "reason": "one sentence explanation"}

Return aligned=false if:
- The diff doesn't address the task at all
- The diff partially addresses it but misses the core requirement
- The diff addresses a different task entirely
- The diff is empty or trivial (only whitespace/comments)

Return aligned=true if the diff makes a reasonable attempt at the task, even if imperfect.
`

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

	prompt := fmt.Sprintf(alignmentPromptTemplate, title, description, diff)

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
						return &AlignmentResult{
							TaskID:  taskID,
							Aligned: resp.Aligned,
							Reason:  resp.Reason,
						}, nil
					}
				}
			}
		}
		return nil, fmt.Errorf("parse alignment JSON: %w\nraw output:\n%s", err, output)
	}

	return &AlignmentResult{
		TaskID:  taskID,
		Aligned: resp.Aligned,
		Reason:  resp.Reason,
	}, nil
}
