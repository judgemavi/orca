package mcp

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseArgs_ValidJSON(t *testing.T) {
	type args struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	raw := json.RawMessage(`{"name":"test","count":42}`)
	got, err := parseArgs[args](raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Name != "test" || got.Count != 42 {
		t.Fatalf("got %+v, want {Name:test Count:42}", got)
	}
}

func TestParseArgs_InvalidJSON(t *testing.T) {
	type args struct {
		Name string `json:"name"`
	}
	raw := json.RawMessage(`{invalid`)
	_, err := parseArgs[args](raw)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
	if !strings.Contains(err.Error(), "parse args") {
		t.Fatalf("error should contain 'parse args', got: %v", err)
	}
}

func TestParseArgs_EmptyObject(t *testing.T) {
	type args struct {
		Status string `json:"status"`
		Count  int    `json:"count"`
	}
	raw := json.RawMessage(`{}`)
	got, err := parseArgs[args](raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Status != "" || got.Count != 0 {
		t.Fatalf("expected zero values, got %+v", got)
	}
}

func TestParseArgs_ExtraFields(t *testing.T) {
	type args struct {
		Name string `json:"name"`
	}
	raw := json.RawMessage(`{"name":"test","extra":"ignored"}`)
	got, err := parseArgs[args](raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Name != "test" {
		t.Fatalf("got %+v, want {Name:test}", got)
	}
}

func TestParseArgs_NullRawMessage(t *testing.T) {
	type args struct {
		Name string `json:"name"`
	}
	_, err := parseArgs[args](nil)
	if err == nil {
		t.Fatal("expected error for nil RawMessage")
	}
	if !strings.Contains(err.Error(), "parse args") {
		t.Fatalf("error should contain 'parse args', got: %v", err)
	}
}
