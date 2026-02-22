package pty

import (
	"bufio"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestManagerCreateWriteReadKill(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}

	m := NewManager()
	t.Cleanup(m.Cleanup)

	s, err := m.Create(CreateOpts{
		Type:    SessionWorker,
		Command: bash,
		Args:    []string{"--noprofile", "--norc"},
		Tool:    "bash",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	if s.ExitCode != -1 {
		t.Fatalf("expected running session exit code -1, got %d", s.ExitCode)
	}
	if s.Cols != 80 || s.Rows != 24 {
		t.Fatalf("expected default size 80x24, got %dx%d", s.Cols, s.Rows)
	}

	r, err := m.Reader(s.ID)
	if err != nil {
		t.Fatalf("reader: %v", err)
	}

	if _, err := m.Write(s.ID, []byte("echo hello\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	lines := make(chan string, 32)
	errs := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(r)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		errs <- scanner.Err()
	}()

	deadline := time.After(5 * time.Second)
	for {
		select {
		case line := <-lines:
			if strings.Contains(line, "hello") {
				goto found
			}
		case err := <-errs:
			if err != nil {
				t.Fatalf("read error: %v", err)
			}
			t.Fatal("pty closed before expected output")
		case <-deadline:
			t.Fatal("timed out waiting for hello output")
		}
	}

found:
	if err := m.Kill(s.ID); err != nil {
		t.Fatalf("kill: %v", err)
	}
	if m.Get(s.ID) != nil {
		t.Fatalf("session %s still active after kill", s.ID)
	}
}
