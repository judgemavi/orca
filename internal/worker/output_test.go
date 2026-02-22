package worker

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/jasjeetmavi/pod/internal/config"
)

func TestExtractOutputStdoutMode(t *testing.T) {
	stdout := "raw tool output"
	got := ExtractOutput(config.ToolOutputConfig{Mode: "stdout"}, stdout, t.TempDir())
	if got != stdout {
		t.Fatalf("ExtractOutput(stdout) = %q, want %q", got, stdout)
	}
}

func TestExtractOutputJSONEnvelopeMode(t *testing.T) {
	stdout := `{"type":"result","result":"Here is the analysis..."}`
	got := ExtractOutput(config.ToolOutputConfig{
		Mode:        "json_envelope",
		ResultField: "result",
	}, stdout, t.TempDir())
	if got != "Here is the analysis..." {
		t.Fatalf("ExtractOutput(json_envelope) = %q, want %q", got, "Here is the analysis...")
	}
}

func TestExtractOutputJSONEnvelopeFallbackOnMissingField(t *testing.T) {
	stdout := `{"type":"result","result":"Here is the analysis..."}`
	got := ExtractOutput(config.ToolOutputConfig{
		Mode:        "json_envelope",
		ResultField: "missing.path",
	}, stdout, t.TempDir())
	if got != stdout {
		t.Fatalf("ExtractOutput(json_envelope missing field) = %q, want passthrough", got)
	}
}

func TestExtractOutputFileMode(t *testing.T) {
	worktree := t.TempDir()
	target := filepath.Join(worktree, ".pod", "result.txt")
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(target, []byte("file result"), 0644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	got := ExtractOutput(config.ToolOutputConfig{
		Mode:       "file",
		ResultPath: "{{worktree}}/.pod/result.txt",
	}, "stdout fallback", worktree)
	if got != "file result" {
		t.Fatalf("ExtractOutput(file) = %q, want %q", got, "file result")
	}
}

func TestExtractOutputFileModeFallbackWhenMissing(t *testing.T) {
	stdout := "stdout fallback"
	got := ExtractOutput(config.ToolOutputConfig{
		Mode:       "file",
		ResultPath: "missing.txt",
	}, stdout, t.TempDir())
	if got != stdout {
		t.Fatalf("ExtractOutput(file missing) = %q, want %q", got, stdout)
	}
}

func TestExtractOutputRegexMode(t *testing.T) {
	stdout := "status=ok result: final answer"
	got := ExtractOutput(config.ToolOutputConfig{
		Mode:    "regex",
		Pattern: `result:\s*(.+)$`,
	}, stdout, t.TempDir())
	if got != "final answer" {
		t.Fatalf("ExtractOutput(regex) = %q, want %q", got, "final answer")
	}
}

func TestExtractOutputRegexFallbackWhenNoMatch(t *testing.T) {
	stdout := "status=ok without capture"
	got := ExtractOutput(config.ToolOutputConfig{
		Mode:    "regex",
		Pattern: `result:\s*(.+)$`,
	}, stdout, t.TempDir())
	if got != stdout {
		t.Fatalf("ExtractOutput(regex no match) = %q, want %q", got, stdout)
	}
}

func TestExtractOutputEmptyStdout(t *testing.T) {
	got := ExtractOutput(config.ToolOutputConfig{Mode: "stdout"}, "", t.TempDir())
	if got != "" {
		t.Fatalf("ExtractOutput(empty) = %q, want empty", got)
	}
}
