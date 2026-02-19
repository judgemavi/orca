package review

import (
	"testing"

	"github.com/jasjeetmavi/pod/internal/config"
)

func TestReviewBatchContinuesOnError(t *testing.T) {
	// Use a nonexistent binary so every review fails at the exec level.
	toolCfg := config.ToolConfig{
		Binary:       "nonexistent-tool-that-does-not-exist",
		HeadlessArgs: []string{"{{prompt}}"},
		Timeout:      "10s",
	}

	dir := t.TempDir()
	r := New(toolCfg, dir)

	inputs := []ReviewInput{
		{TaskID: "t1", Title: "Task 1", Description: "desc", Diff: "diff1"},
		{TaskID: "t2", Title: "Task 2", Description: "desc", Diff: "diff2"},
	}

	results, err := r.ReviewBatch(inputs)
	if err != nil {
		t.Fatalf("ReviewBatch returned error: %v (should continue on per-task errors)", err)
	}

	if len(results) != 2 {
		t.Fatalf("got %d results, want 2", len(results))
	}

	for i, res := range results {
		if res.Approved {
			t.Errorf("result[%d] approved = true, want false", i)
		}
		if res.Feedback == "" {
			t.Errorf("result[%d] feedback is empty, want error message", i)
		}
	}
}
