package logging

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestQuery_AppliesFilters(t *testing.T) {
	p := filepath.Join(t.TempDir(), "orca.log")
	data := "" +
		"{\"time\":\"2026-01-02T10:00:00Z\",\"level\":\"INFO\",\"msg\":\"boot\",\"task_id\":\"t-1\"}\n" +
		"{\"time\":\"2026-01-02T10:01:00Z\",\"level\":\"ERROR\",\"msg\":\"task failed\",\"task_id\":\"t-2\"}\n" +
		"{\"time\":\"2026-01-02T10:02:00Z\",\"level\":\"ERROR\",\"msg\":\"task failed hard\",\"task_id\":\"t-2\"}\n"
	if err := os.WriteFile(p, []byte(data), 0644); err != nil {
		t.Fatalf("write log: %v", err)
	}

	since := time.Date(2026, 1, 2, 10, 0, 30, 0, time.UTC)
	got, err := Query(p, Filter{
		Level:   "error",
		TaskID:  "t-2",
		Since:   since,
		Pattern: "failed",
		Limit:   1,
	})
	if err != nil {
		t.Fatalf("query: %v", err)
	}

	if len(got) != 1 {
		t.Fatalf("matches = %d, want 1", len(got))
	}
	if got[0].Msg != "task failed" {
		t.Fatalf("msg = %q, want %q", got[0].Msg, "task failed")
	}
	if got[0].Level != "ERROR" {
		t.Fatalf("level = %q, want %q", got[0].Level, "ERROR")
	}
	if got[0].Attrs["task_id"] != "t-2" {
		t.Fatalf("task_id = %v, want t-2", got[0].Attrs["task_id"])
	}
}

func TestQuery_AttrsOptional(t *testing.T) {
	p := filepath.Join(t.TempDir(), "orca.log")
	data := "{\"time\":\"2026-01-02T10:00:00Z\",\"level\":\"INFO\",\"msg\":\"boot\"}\n"
	if err := os.WriteFile(p, []byte(data), 0644); err != nil {
		t.Fatalf("write log: %v", err)
	}

	got, err := Query(p, Filter{})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("matches = %d, want 1", len(got))
	}
	if got[0].Attrs != nil {
		t.Fatalf("attrs = %#v, want nil", got[0].Attrs)
	}
}

func TestQuery_InvalidJSON(t *testing.T) {
	p := filepath.Join(t.TempDir(), "orca.log")
	if err := os.WriteFile(p, []byte("{bad}\n"), 0644); err != nil {
		t.Fatalf("write log: %v", err)
	}

	_, err := Query(p, Filter{})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestQuery_RequiresPath(t *testing.T) {
	_, err := Query("", Filter{})
	if err == nil {
		t.Fatal("expected error")
	}
}
