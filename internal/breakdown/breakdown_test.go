package breakdown

import (
	"reflect"
	"testing"
)

func TestParseProposedTasksMarkdownTemplate(t *testing.T) {
	raw := `## Tasks

### Task 1
- Title: Add API
- Description: Implement endpoint
- Depends On: none
- Suggested Tool: codex

### Task 2
- Title: Add UI
- Description: Wire button
- Depends On: 1
- Suggested Tool: claude`

	got, err := parseProposedTasks(raw)
	if err != nil {
		t.Fatalf("parseProposedTasks() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(tasks) = %d, want 2", len(got))
	}
	if got[1].Title != "Add UI" {
		t.Fatalf("task2 title = %q, want %q", got[1].Title, "Add UI")
	}
	if !reflect.DeepEqual(got[1].DependsOnIndices, []int{0}) {
		t.Fatalf("task2 deps = %#v, want %#v", got[1].DependsOnIndices, []int{0})
	}
	if got[1].SuggestedTool != "claude" {
		t.Fatalf("task2 suggested_tool = %q, want %q", got[1].SuggestedTool, "claude")
	}
}

func TestParseProposedTasksErrorsWhenNoTasks(t *testing.T) {
	raw := "## Tasks\n\nNone."
	_, err := parseProposedTasks(raw)
	if err == nil {
		t.Fatal("parseProposedTasks() error = nil, want non-nil")
	}
}
