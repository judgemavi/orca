package driver

import (
	"reflect"
	"testing"
)

func TestGet(t *testing.T) {
	d, ok := Get("ClAuDe")
	if !ok {
		t.Fatal("Get(claude) not found")
	}
	if d.Name() != "claude" {
		t.Fatalf("Name=%q want=claude", d.Name())
	}
}

func TestAvailable(t *testing.T) {
	got := Available()
	want := []string{"claude", "codex"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Available=%v want=%v", got, want)
	}
}
