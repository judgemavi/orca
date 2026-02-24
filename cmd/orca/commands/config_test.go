package commands

import (
	"encoding/json"
	"testing"
)

func TestBuildConfigPatchNestedPath(t *testing.T) {
	patch, err := buildConfigPatch("defaults.tool", "codex")
	if err != nil {
		t.Fatalf("buildConfigPatch: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(patch, &decoded); err != nil {
		t.Fatalf("unmarshal patch: %v", err)
	}

	defaults, ok := decoded["defaults"].(map[string]interface{})
	if !ok {
		t.Fatalf("defaults missing or invalid type: %#v", decoded["defaults"])
	}
	if got := defaults["tool"]; got != "codex" {
		t.Fatalf("defaults.tool = %#v, want codex", got)
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
