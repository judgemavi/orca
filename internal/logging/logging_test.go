package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestRotatingWriter_RotatesToDotOne(t *testing.T) {
	logFile := filepath.Join(t.TempDir(), "app.log")
	w, err := NewRotatingWriter(logFile, 32)
	if err != nil {
		t.Fatalf("new rotating writer: %v", err)
	}
	t.Cleanup(func() { _ = w.Close() })

	first := []byte("first-entry-12345\n")
	second := []byte("second-entry-12345\n")

	if _, err := w.Write(first); err != nil {
		t.Fatalf("write first: %v", err)
	}
	if _, err := w.Write(second); err != nil {
		t.Fatalf("write second: %v", err)
	}

	rotated, err := os.ReadFile(logFile + ".1")
	if err != nil {
		t.Fatalf("read rotated file: %v", err)
	}
	if !bytes.Equal(rotated, first) {
		t.Fatalf("rotated content = %q, want %q", string(rotated), string(first))
	}

	current, err := os.ReadFile(logFile)
	if err != nil {
		t.Fatalf("read current file: %v", err)
	}
	if !bytes.Equal(current, second) {
		t.Fatalf("current content = %q, want %q", string(current), string(second))
	}
}

func TestInit_UsesJSONAndLevel(t *testing.T) {
	old := slog.Default()
	t.Cleanup(func() { slog.SetDefault(old) })

	logFile := filepath.Join(t.TempDir(), "orca.log")
	if err := Init(Config{
		Level:   "warn",
		File:    logFile,
		MaxSize: "1mb",
	}); err != nil {
		t.Fatalf("init: %v", err)
	}

	slog.Info("skip-me", "k", "v")
	slog.Warn("keep-me", "k", "v")

	data, err := os.ReadFile(logFile)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}

	lines := bytes.Split(bytes.TrimSpace(data), []byte{'\n'})
	if len(lines) != 1 {
		t.Fatalf("line count = %d, want 1", len(lines))
	}

	var payload map[string]any
	if err := json.Unmarshal(lines[0], &payload); err != nil {
		t.Fatalf("unmarshal json log line: %v", err)
	}
	if payload["msg"] != "keep-me" {
		t.Fatalf("msg = %v, want keep-me", payload["msg"])
	}
	if payload["k"] != "v" {
		t.Fatalf("k = %v, want v", payload["k"])
	}
}

func TestInit_InvalidLevel(t *testing.T) {
	err := Init(Config{
		Level:   "verbose",
		File:    filepath.Join(t.TempDir(), "orca.log"),
		MaxSize: "1mb",
	})
	if err == nil {
		t.Fatal("expected error for invalid level")
	}
}

func TestParseMaxSize(t *testing.T) {
	tests := []struct {
		in      string
		want    int64
		wantErr bool
	}{
		{in: "50mb", want: 50 * 1024 * 1024},
		{in: "1kb", want: 1024},
		{in: "2GB", want: 2 * 1024 * 1024 * 1024},
		{in: "4096", want: 4096},
		{in: "0mb", wantErr: true},
		{in: "12xb", wantErr: true},
		{in: "x", wantErr: true},
	}

	for _, tt := range tests {
		got, err := ParseMaxSize(tt.in)
		if tt.wantErr {
			if err == nil {
				t.Fatalf("ParseMaxSize(%q): expected error", tt.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("ParseMaxSize(%q): %v", tt.in, err)
		}
		if got != tt.want {
			t.Fatalf("ParseMaxSize(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}
