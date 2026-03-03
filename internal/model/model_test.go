package model

import (
	"testing"

	"github.com/jasjeetmavi/orca/internal/config"
)

func TestForTool(t *testing.T) {
	got, ok := ForTool("claude")
	if !ok {
		t.Fatal("expected claude models")
	}
	if len(got) == 0 {
		t.Fatal("expected models")
	}
	if got[0].Provider != "claude" {
		t.Fatalf("provider=%q", got[0].Provider)
	}
}

func TestAllFromConfig(t *testing.T) {
	cfg := &config.Config{Tools: []string{"claude", "codex"}}
	got := AllFromConfig(cfg)
	if len(got) != 2 {
		t.Fatalf("tools=%d, want 2", len(got))
	}
}
