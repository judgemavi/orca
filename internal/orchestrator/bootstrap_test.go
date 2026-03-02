package orchestrator

import (
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/driver"
)

func TestBuildLaunchArgs(t *testing.T) {
	d, _ := driver.Get("claude")
	args := BuildLaunchArgs(d, "claude-sonnet-4-6", "/tmp/mcp.json")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "/tmp/mcp.json") {
		t.Fatalf("args missing mcp config: %v", args)
	}
}
