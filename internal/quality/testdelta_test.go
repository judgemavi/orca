package quality

import (
	"strings"
	"testing"
)

func TestTakeSnapshotEchoOK(t *testing.T) {
	snap, err := TakeSnapshot(".", []string{`echo "ok"`})
	if err != nil {
		t.Fatalf("TakeSnapshot returned error: %v", err)
	}

	if len(snap.Results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(snap.Results))
	}

	result := snap.Results[0]
	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", result.ExitCode)
	}

	if strings.TrimSpace(result.Output) != "ok" {
		t.Fatalf("expected output %q, got %q", "ok", result.Output)
	}
}

func TestTakeSnapshotExitOne(t *testing.T) {
	snap, err := TakeSnapshot(".", []string{"exit 1"})
	if err != nil {
		t.Fatalf("TakeSnapshot returned error: %v", err)
	}

	if len(snap.Results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(snap.Results))
	}

	if snap.Results[0].ExitCode != 1 {
		t.Fatalf("expected exit code 1, got %d", snap.Results[0].ExitCode)
	}
}

func TestComputeDeltaNewFailure(t *testing.T) {
	before := &Snapshot{
		Results: []CommandResult{
			{Command: "cmd-a", ExitCode: 0},
			{Command: "cmd-b", ExitCode: 0},
		},
	}
	after := &Snapshot{
		Results: []CommandResult{
			{Command: "cmd-a", ExitCode: 0},
			{Command: "cmd-b", ExitCode: 1},
		},
	}

	delta := ComputeDelta(before, after)
	if len(delta.NewFailures) != 1 || delta.NewFailures[0] != "cmd-b" {
		t.Fatalf("expected cmd-b in NewFailures, got %#v", delta.NewFailures)
	}
}

func TestParseTestCountGoOKLine(t *testing.T) {
	output := "ok  pkg/foo 0.3s"
	count := ParseTestCount(output)
	if count != 1 {
		t.Fatalf("expected 1, got %d", count)
	}
}

func TestParseTestCountUnparseable(t *testing.T) {
	output := "this output has no test count"
	count := ParseTestCount(output)
	if count != -1 {
		t.Fatalf("expected -1, got %d", count)
	}
}
