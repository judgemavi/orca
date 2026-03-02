package model

import (
	"testing"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/driver"
)

func TestFromDriver(t *testing.T) {
	d, _ := driver.Get("claude")
	got := FromDriver("claude", d)
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
