package worker

import (
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
)

func TestNewAdapter(t *testing.T) {
	d, _ := driver.Get("claude")
	a := NewAdapter(d, "claude-sonnet-4-6", time.Minute)
	if a == nil || a.Driver == nil {
		t.Fatal("expected adapter with driver")
	}
}
