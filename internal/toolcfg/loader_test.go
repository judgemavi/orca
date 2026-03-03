package toolcfg

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLoadValidConfig(t *testing.T) {
	path := writeConfig(t, `{
  "tools": {
    "claude": {
      "binary": "claude",
      "models": ["claude-opus-4-6"],
      "args": [
        { "param": "-p", "variable": "prompt", "used_in": ["headless"] },
        { "param": "--model", "variable": "model", "used_in": ["headless", "resume"] },
        { "param": "--resume", "variable": "session_id", "used_in": ["resume"] }
      ],
      "session_id": { "mode": "json", "key": "session_id" },
      "timeout": "600s"
    }
  }
}`)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	tool, ok := cfg.Tools["claude"]
	if !ok {
		t.Fatal("missing claude tool")
	}
	if tool.Binary != "claude" {
		t.Fatalf("binary = %q, want claude", tool.Binary)
	}
	if len(tool.Models) != 1 || tool.Models[0] != "claude-opus-4-6" {
		t.Fatalf("models = %v", tool.Models)
	}
	if len(tool.Args) == 0 {
		t.Fatal("args should be loaded")
	}
	d, err := tool.TimeoutDuration()
	if err != nil {
		t.Fatalf("TimeoutDuration: %v", err)
	}
	if d != 10*time.Minute {
		t.Fatalf("timeout = %s, want %s", d, 10*time.Minute)
	}
}

func TestLoadValidConfigWithPromptArgSharedAcrossModes(t *testing.T) {
	path := writeConfig(t, `{
  "tools": {
    "claude": {
      "binary": "claude",
      "models": ["claude-opus-4-6"],
      "args": [
        { "param": "-p", "variable": "prompt", "used_in": ["headless", "resume"] },
        { "param": "--resume", "variable": "session_id", "used_in": ["resume"] }
      ],
      "session_id": { "mode": "json", "key": "session_id" },
      "timeout": "600s"
    }
  }
}`)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	tool := cfg.Tools["claude"]
	resolved := tool.ResolveArgs(ArgsModeHeadless, map[string]string{"prompt": "hello"})
	if !reflect.DeepEqual(resolved, []string{"-p", "hello"}) {
		t.Fatalf("resolved args = %#v", resolved)
	}
}

func TestLoadValidationErrors(t *testing.T) {
	tests := []struct {
		name        string
		content     string
		wantErrText string
	}{
		{
			name: "binary required",
			content: `{"tools":{"claude":{
				"binary":"",
				"models":["claude-opus-4-6"],
				"args":[{"param":"-p","variable":"prompt","used_in":["headless"]}],
				"session_id":{"mode":"json","key":"session_id"},
				"timeout":"600s"
			}}}`,
			wantErrText: "tools.claude.binary must be non-empty",
		},
		{
			name: "at least one model",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":[],
				"args":[{"param":"-p","variable":"prompt","used_in":["headless"]}],
				"session_id":{"mode":"json","key":"session_id"},
				"timeout":"600s"
			}}}`,
			wantErrText: "tools.claude.models must contain at least one model",
		},
		{
			name: "headless requires prompt variable",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":["claude-opus-4-6"],
				"args":[{"param":"--model","variable":"model","used_in":["headless"]}],
				"session_id":{"mode":"json","key":"session_id"},
				"timeout":"600s"
			}}}`,
			wantErrText: "tools.claude.args must include variable=prompt for headless mode",
		},
		{
			name: "arg param required",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":["claude-opus-4-6"],
				"args":[{"param":"","variable":"prompt","used_in":["headless"]}],
				"session_id":{"mode":"json","key":"session_id"},
				"timeout":"600s"
			}}}`,
			wantErrText: "tools.claude.args[0].param must be non-empty",
		},
		{
			name: "value and variable are exclusive",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":["claude-opus-4-6"],
				"args":[{"param":"-p","value":"x","variable":"prompt","used_in":["headless"]}],
				"session_id":{"mode":"json","key":"session_id"},
				"timeout":"600s"
			}}}`,
			wantErrText: "mutually exclusive",
		},
		{
			name: "invalid variable",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":["claude-opus-4-6"],
				"args":[{"param":"-p","variable":"unknown_var","used_in":["headless"]}],
				"session_id":{"mode":"json","key":"session_id"},
				"timeout":"600s"
			}}}`,
			wantErrText: "is not supported",
		},
		{
			name: "used_in required",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":["claude-opus-4-6"],
				"args":[{"param":"-p","variable":"prompt","used_in":[]}],
				"session_id":{"mode":"json","key":"session_id"},
				"timeout":"600s"
			}}}`,
			wantErrText: "used_in must contain at least one mode",
		},
		{
			name: "used_in invalid mode",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":["claude-opus-4-6"],
				"args":[{"param":"-p","variable":"prompt","used_in":["bogus"]}],
				"session_id":{"mode":"json","key":"session_id"},
				"timeout":"600s"
			}}}`,
			wantErrText: "contains invalid mode",
		},
		{
			name: "session id json mode requires key",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":["claude-opus-4-6"],
				"args":[{"param":"-p","variable":"prompt","used_in":["headless"]}],
				"session_id":{"mode":"json"},
				"timeout":"600s"
			}}}`,
			wantErrText: "tools.claude.session_id.key is required when mode=json",
		},
		{
			name: "session id pattern mode requires valid regex",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":["claude-opus-4-6"],
				"args":[{"param":"-p","variable":"prompt","used_in":["headless"]}],
				"session_id":{"mode":"pattern","pattern":"("},
				"timeout":"600s"
			}}}`,
			wantErrText: "tools.claude.session_id.pattern must be a valid regex",
		},
		{
			name: "timeout must parse",
			content: `{"tools":{"claude":{
				"binary":"claude",
				"models":["claude-opus-4-6"],
				"args":[{"param":"-p","variable":"prompt","used_in":["headless"]}],
				"session_id":{"mode":"json","key":"session_id"},
				"timeout":"not-a-duration"
			}}}`,
			wantErrText: "tools.claude.timeout must be a valid duration",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := writeConfig(t, tt.content)
			_, err := Load(path)
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tt.wantErrText) {
				t.Fatalf("error = %q, want substring %q", err.Error(), tt.wantErrText)
			}
		})
	}
}

func TestResolveArgs(t *testing.T) {
	tool := Tool{
		Args: []Arg{
			{Param: "-p", Variable: "prompt", UsedIn: []string{"headless"}},
			{Param: "--model", Variable: "model", UsedIn: []string{"headless", "resume"}},
			{Param: "--verbose", UsedIn: []string{"headless", "resume"}},
			{Param: "--resume", Variable: "session_id", UsedIn: []string{"resume"}},
		},
	}
	vars := map[string]string{
		"prompt":     "build feature",
		"model":      "gpt-5.3-codex",
		"session_id": "sess-123",
	}

	headless := tool.ResolveArgs(ArgsModeHeadless, vars)
	if !reflect.DeepEqual(headless, []string{"-p", "build feature", "--model", "gpt-5.3-codex", "--verbose"}) {
		t.Fatalf("headless args = %#v", headless)
	}
	resume := tool.ResolveArgs(ArgsModeResume, vars)
	if !reflect.DeepEqual(resume, []string{"--model", "gpt-5.3-codex", "--verbose", "--resume", "sess-123"}) {
		t.Fatalf("resume args = %#v", resume)
	}
}

func TestExtractSessionIDJSONMode(t *testing.T) {
	cfg := SessionID{Mode: "json", Key: "result.session_id"}
	line := `{"result":{"session_id":"abcd-1234"}}`
	if got := ExtractSessionID(cfg, line); got != "abcd-1234" {
		t.Fatalf("ExtractSessionID(json) = %q, want abcd-1234", got)
	}
	if got := ExtractSessionID(cfg, "not-json"); got != "" {
		t.Fatalf("ExtractSessionID(json invalid) = %q, want empty", got)
	}
	if got := ExtractSessionID(SessionID{Mode: "json", Key: "missing"}, line); got != "" {
		t.Fatalf("ExtractSessionID(json missing) = %q, want empty", got)
	}
}

func TestExtractSessionIDPatternMode(t *testing.T) {
	cfg := SessionID{Mode: "pattern", Pattern: `session:([a-z0-9-]+)`}
	line := "session:abcd-1234"
	if got := ExtractSessionID(cfg, line); got != "abcd-1234" {
		t.Fatalf("ExtractSessionID(pattern) = %q, want abcd-1234", got)
	}
	if got := ExtractSessionID(cfg, "no session"); got != "" {
		t.Fatalf("ExtractSessionID(pattern no-match) = %q, want empty", got)
	}
	if got := ExtractSessionID(SessionID{Mode: "pattern", Pattern: "("}, line); got != "" {
		t.Fatalf("ExtractSessionID(pattern invalid) = %q, want empty", got)
	}
}

func writeConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tools.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}
