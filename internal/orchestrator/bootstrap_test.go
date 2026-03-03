package orchestrator

import (
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/config"
)

func TestBuildLaunchArgs(t *testing.T) {
	tool, ok := config.ToolDefinition("claude")
	if !ok {
		t.Fatal("claude tool definition not found")
	}
	args := BuildLaunchArgs(tool, "claude-sonnet-4-6", "/tmp/mcp.json")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "/tmp/mcp.json") {
		t.Fatalf("args missing mcp config: %v", args)
	}
}
