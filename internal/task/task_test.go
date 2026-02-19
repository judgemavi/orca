package task

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/jasjeetmavi/pod/internal/state"
)

func testDB(t *testing.T) *state.DB {
	t.Helper()
	tmpDir := t.TempDir()
	db, err := state.Open(filepath.Join(tmpDir, "test.db"))
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestCreate(t *testing.T) {
	store := NewStore(testDB(t))

	task, err := store.Create("Do something", "A description", "", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(task.ID) != 36 {
		t.Errorf("expected 36-char UUID, got %d chars: %s", len(task.ID), task.ID)
	}
	if task.Title != "Do something" {
		t.Errorf("title = %q, want %q", task.Title, "Do something")
	}
	if task.Status != "pending" {
		t.Errorf("status = %q, want %q", task.Status, "pending")
	}

	task2, err := store.Create("Another task", "", "", "claude")
	if err != nil {
		t.Fatalf("create with tool: %v", err)
	}
	if task2.AssignedTool != "claude" {
		t.Errorf("assigned_tool = %q, want %q", task2.AssignedTool, "claude")
	}
}

func TestGet(t *testing.T) {
	store := NewStore(testDB(t))

	created, err := store.Create("Get me", "desc", "", "codex")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := store.Get(created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.ID != created.ID {
		t.Errorf("id = %q, want %q", got.ID, created.ID)
	}
	if got.Title != "Get me" {
		t.Errorf("title = %q, want %q", got.Title, "Get me")
	}
	if got.Description != "desc" {
		t.Errorf("description = %q, want %q", got.Description, "desc")
	}
	if got.AssignedTool != "codex" {
		t.Errorf("assigned_tool = %q, want %q", got.AssignedTool, "codex")
	}
	if got.Status != "pending" {
		t.Errorf("status = %q, want %q", got.Status, "pending")
	}
}

func TestUpdate(t *testing.T) {
	store := NewStore(testDB(t))

	created, err := store.Create("Original", "", "", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	err = store.Update(created.ID, map[string]interface{}{
		"title":  "Updated",
		"status": "running",
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}

	got, err := store.Get(created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Title != "Updated" {
		t.Errorf("title = %q, want %q", got.Title, "Updated")
	}
	if got.Status != "running" {
		t.Errorf("status = %q, want %q", got.Status, "running")
	}

	// Update non-existent ID
	err = store.Update("nonexistent-id-that-does-not-exist-x", map[string]interface{}{"title": "nope"})
	if err == nil {
		t.Fatal("expected error for non-existent ID")
	}
	if !contains(err.Error(), "not found") {
		t.Errorf("error = %q, want it to contain 'not found'", err.Error())
	}
}

func TestResolveID(t *testing.T) {
	store := NewStore(testDB(t))

	created, err := store.Create("Resolve me", "", "", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Prefix resolve
	prefix := created.ID[:8]
	resolved, err := store.ResolveID(prefix)
	if err != nil {
		t.Fatalf("resolve prefix: %v", err)
	}
	if resolved != created.ID {
		t.Errorf("resolved = %q, want %q", resolved, created.ID)
	}

	// Full ID passthrough
	resolved, err = store.ResolveID(created.ID)
	if err != nil {
		t.Fatalf("resolve full: %v", err)
	}
	if resolved != created.ID {
		t.Errorf("resolved = %q, want %q", resolved, created.ID)
	}

	// Non-existent prefix
	_, err = store.ResolveID("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent prefix")
	}
	if !contains(err.Error(), "no task matching") {
		t.Errorf("error = %q, want it to contain 'no task matching'", err.Error())
	}
}

func TestGetReady(t *testing.T) {
	store := NewStore(testDB(t))

	a, err := store.Create("Task A", "", "", "")
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	b, err := store.Create("Task B", "", "", "")
	if err != nil {
		t.Fatalf("create B: %v", err)
	}
	c, err := store.Create("Task C", "", "", "")
	if err != nil {
		t.Fatalf("create C: %v", err)
	}

	// C depends on A
	if err := store.AddDependency(c.ID, a.ID); err != nil {
		t.Fatalf("add dep: %v", err)
	}

	ready, err := store.GetReady()
	if err != nil {
		t.Fatalf("get ready: %v", err)
	}
	readyIDs := ids(ready)
	if !containsID(readyIDs, a.ID) || !containsID(readyIDs, b.ID) {
		t.Errorf("expected A and B in ready, got %v", readyIDs)
	}
	if containsID(readyIDs, c.ID) {
		t.Errorf("C should not be ready (blocked by A)")
	}

	// Complete A → C should become ready
	if err := store.Update(a.ID, map[string]interface{}{"status": "completed"}); err != nil {
		t.Fatalf("complete A: %v", err)
	}

	ready, err = store.GetReady()
	if err != nil {
		t.Fatalf("get ready after complete: %v", err)
	}
	readyIDs = ids(ready)
	if !containsID(readyIDs, b.ID) || !containsID(readyIDs, c.ID) {
		t.Errorf("expected B and C in ready, got %v", readyIDs)
	}
}

func TestAddRemoveDependency(t *testing.T) {
	store := NewStore(testDB(t))

	a, err := store.Create("Task A", "", "", "")
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	b, err := store.Create("Task B", "", "", "")
	if err != nil {
		t.Fatalf("create B: %v", err)
	}

	if err := store.AddDependency(b.ID, a.ID); err != nil {
		t.Fatalf("add dep: %v", err)
	}

	got, err := store.Get(b.ID)
	if err != nil {
		t.Fatalf("get B: %v", err)
	}
	if len(got.DependsOn) != 1 || got.DependsOn[0] != a.ID {
		t.Errorf("depends_on = %v, want [%s]", got.DependsOn, a.ID)
	}

	if err := store.RemoveDependency(b.ID, a.ID); err != nil {
		t.Fatalf("remove dep: %v", err)
	}

	got, err = store.Get(b.ID)
	if err != nil {
		t.Fatalf("get B after remove: %v", err)
	}
	if len(got.DependsOn) != 0 {
		t.Errorf("depends_on = %v, want empty", got.DependsOn)
	}
}

func TestDelete(t *testing.T) {
	store := NewStore(testDB(t))

	a, err := store.Create("Task A", "", "", "")
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	b, err := store.Create("Task B", "", "", "")
	if err != nil {
		t.Fatalf("create B: %v", err)
	}

	if err := store.AddDependency(b.ID, a.ID); err != nil {
		t.Fatalf("add dep: %v", err)
	}

	if err := store.Delete(a.ID); err != nil {
		t.Fatalf("delete A: %v", err)
	}

	_, err = store.Get(a.ID)
	if err == nil {
		t.Fatal("expected error getting deleted task")
	}
}

// --- helpers ---

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchStr(s, substr)
}

func searchStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func ids(tasks []*Task) []string {
	out := make([]string, len(tasks))
	for i, t := range tasks {
		out[i] = t.ID
	}
	return out
}

func containsID(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// Ensure temp dir cleanup works on all platforms.
func init() {
	os.Setenv("TMPDIR", os.TempDir())
}
