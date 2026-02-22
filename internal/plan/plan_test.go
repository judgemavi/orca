package plan

import (
	"strings"
	"testing"

	"github.com/jasjeetmavi/pod/internal/config"
)

func TestBuildPlanPromptIncludesContext(t *testing.T) {
	prompt := buildPlanPrompt("Project layout and conventions", "Add planner", "Create planning package")

	if !strings.Contains(prompt, "## Codebase Context") {
		t.Fatalf("prompt missing codebase context section:\n%s", prompt)
	}
	if !strings.Contains(prompt, "Project layout and conventions") {
		t.Fatalf("prompt missing context body:\n%s", prompt)
	}
	if !strings.Contains(prompt, "**Title:** Add planner") {
		t.Fatalf("prompt missing title:\n%s", prompt)
	}
	if !strings.Contains(prompt, "**Description:** Create planning package") {
		t.Fatalf("prompt missing description:\n%s", prompt)
	}
}

func TestBuildPlanPromptEmptyContext(t *testing.T) {
	prompt := buildPlanPrompt("", "Task", "Desc")

	if strings.Contains(prompt, "## Codebase Context") {
		t.Fatalf("prompt should omit context section when empty:\n%s", prompt)
	}
	if !strings.Contains(prompt, "**Title:** Task") {
		t.Fatalf("prompt missing title:\n%s", prompt)
	}
}

func TestExtractPlanOutputFromClaudeEnvelope(t *testing.T) {
	envelope := `{"type":"result","result":"### Approach\nImplement package\n\n### Steps\n1. Add code"}`
	got := extractPlanOutput(envelope, config.ToolOutputConfig{
		Mode:        "json_envelope",
		ResultField: "result",
	}, t.TempDir())
	want := "### Approach\nImplement package\n\n### Steps\n1. Add code"
	if got != want {
		t.Fatalf("extractPlanOutput(envelope) = %q, want %q", got, want)
	}
}

func TestExtractPlanOutputPlainMarkdown(t *testing.T) {
	plain := "  ### Approach\nUse existing patterns\n"
	got := extractPlanOutput(plain, config.ToolOutputConfig{Mode: "stdout"}, t.TempDir())
	want := "### Approach\nUse existing patterns"
	if got != want {
		t.Fatalf("extractPlanOutput(plain) = %q, want %q", got, want)
	}
}

func TestApplyModelOverride(t *testing.T) {
	cfg := config.ToolConfig{Binary: "claude", Model: "default-model"}

	overridden := applyModelOverride(cfg, "strong-model")
	if overridden.Model != "strong-model" {
		t.Fatalf("overridden model = %q, want %q", overridden.Model, "strong-model")
	}
	if cfg.Model != "default-model" {
		t.Fatalf("original config mutated: model = %q", cfg.Model)
	}

	notOverridden := applyModelOverride(cfg, "")
	if notOverridden.Model != "default-model" {
		t.Fatalf("model with empty override = %q, want %q", notOverridden.Model, "default-model")
	}
}
