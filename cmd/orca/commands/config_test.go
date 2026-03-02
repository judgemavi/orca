package commands

import (
	"encoding/json"
	"testing"
)

func TestBuildConfigPatchNestedPath(t *testing.T) {
	patch, err := buildConfigPatch("orchestrator.supervisor_tool", "codex")
	if err != nil {
		t.Fatalf("buildConfigPatch: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(patch, &decoded); err != nil {
		t.Fatalf("unmarshal patch: %v", err)
	}

	orch, ok := decoded["orchestrator"].(map[string]interface{})
	if !ok {
		t.Fatalf("orchestrator missing or invalid type: %#v", decoded["orchestrator"])
	}
	if got := orch["supervisor_tool"]; got != "codex" {
		t.Fatalf("orchestrator.supervisor_tool = %#v, want codex", got)
	}
}

func TestBuildConfigPatchParsesTypedValues(t *testing.T) {
	patch, err := buildConfigPatch("workers.max_parallel", "5")
	if err != nil {
		t.Fatalf("buildConfigPatch: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(patch, &decoded); err != nil {
		t.Fatalf("unmarshal patch: %v", err)
	}

	workers, ok := decoded["workers"].(map[string]interface{})
	if !ok {
		t.Fatalf("workers missing or invalid type: %#v", decoded["workers"])
	}
	if got := workers["max_parallel"]; got != float64(5) {
		t.Fatalf("workers.max_parallel = %#v, want 5", got)
	}
}
