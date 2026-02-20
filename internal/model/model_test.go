package model

import (
	"reflect"
	"testing"

	"github.com/jasjeetmavi/pod/internal/config"
)

func TestFromConfig(t *testing.T) {
	tc := config.ToolConfig{
		Binary: "claude",
		Models: []string{"opus", "sonnet", "haiku"},
	}

	got := FromConfig("claude", tc)
	want := []Model{
		{ID: "opus", Name: "opus", Provider: "claude"},
		{ID: "sonnet", Name: "sonnet", Provider: "claude"},
		{ID: "haiku", Name: "haiku", Provider: "claude"},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FromConfig() = %#v, want %#v", got, want)
	}
}

func TestFromConfigEmpty(t *testing.T) {
	tc := config.ToolConfig{
		Binary: "claude",
		Models: nil,
	}

	got := FromConfig("claude", tc)
	if len(got) != 0 {
		t.Fatalf("FromConfig() with nil Models returned %d models, want 0", len(got))
	}
}

func TestAllFromConfig(t *testing.T) {
	cfg := &config.Config{
		Tools: map[string]config.ToolConfig{
			"claude": {Binary: "claude", Models: []string{"opus", "sonnet"}},
			"codex":  {Binary: "codex", Models: []string{"o4-mini", "o3"}},
		},
	}

	got := AllFromConfig(cfg)

	if len(got) != 2 {
		t.Fatalf("AllFromConfig() returned %d tools, want 2", len(got))
	}

	claudeModels := got["claude"]
	if len(claudeModels) != 2 || claudeModels[0].ID != "opus" || claudeModels[1].ID != "sonnet" {
		t.Fatalf("claude models = %#v, want opus+sonnet", claudeModels)
	}
	if claudeModels[0].Provider != "claude" {
		t.Fatalf("claude provider = %q, want %q", claudeModels[0].Provider, "claude")
	}

	codexModels := got["codex"]
	if len(codexModels) != 2 || codexModels[0].ID != "o4-mini" || codexModels[1].ID != "o3" {
		t.Fatalf("codex models = %#v, want o4-mini+o3", codexModels)
	}
}
