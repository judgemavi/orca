package mcp

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/model"
)

func TestHandleModelsListTool_AllConfiguredTools(t *testing.T) {
	cfg, err := config.Default()
	if err != nil {
		t.Fatalf("default config: %v", err)
	}
	cfg.Tools = []string{"claude", "codex"}

	s := &Server{config: &cfg}
	got, err := s.HandleModelsListTool(json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("HandleModelsListTool returned error: %v", err)
	}

	modelsByTool, ok := got.(map[string][]model.Model)
	if !ok {
		t.Fatalf("unexpected response type %T", got)
	}
	if len(modelsByTool) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(modelsByTool))
	}
	if len(modelsByTool["claude"]) == 0 {
		t.Fatal("expected claude models to be present")
	}
	if len(modelsByTool["codex"]) == 0 {
		t.Fatal("expected codex models to be present")
	}
}

func TestHandleModelsListTool_FilterByTool(t *testing.T) {
	cfg, err := config.Default()
	if err != nil {
		t.Fatalf("default config: %v", err)
	}
	cfg.Tools = []string{"claude", "codex"}

	s := &Server{config: &cfg}
	got, err := s.HandleModelsListTool(json.RawMessage(`{"tool":"codex"}`))
	if err != nil {
		t.Fatalf("HandleModelsListTool returned error: %v", err)
	}

	modelsByTool, ok := got.(map[string][]model.Model)
	if !ok {
		t.Fatalf("unexpected response type %T", got)
	}
	if len(modelsByTool) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(modelsByTool))
	}
	if _, exists := modelsByTool["claude"]; exists {
		t.Fatal("did not expect claude models in filtered response")
	}
	if len(modelsByTool["codex"]) == 0 {
		t.Fatal("expected codex models to be present")
	}
}

func TestHandleModelsListTool_UnknownTool(t *testing.T) {
	cfg, err := config.Default()
	if err != nil {
		t.Fatalf("default config: %v", err)
	}
	s := &Server{config: &cfg}

	_, err = s.HandleModelsListTool(json.RawMessage(`{"tool":"nope"}`))
	if err == nil {
		t.Fatal("expected error for unknown tool")
	}
	if !strings.Contains(err.Error(), `tool "nope" not found`) {
		t.Fatalf("unexpected error: %v", err)
	}
}
