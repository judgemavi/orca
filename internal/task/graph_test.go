package task

import (
	"slices"
	"testing"
)

func TestTopoSort_NoDeps(t *testing.T) {
	ids := []string{"a", "b", "c"}
	got := TopoSort(ids, func(string) []string { return nil })
	if !slices.Equal(got, ids) {
		t.Fatalf("got %v, want %v", got, ids)
	}
}

func TestTopoSort_LinearChain(t *testing.T) {
	// C depends on B, B depends on A → expect A, B, C
	deps := map[string][]string{
		"A": {},
		"B": {"A"},
		"C": {"B"},
	}
	got := TopoSort([]string{"C", "B", "A"}, func(id string) []string { return deps[id] })
	want := []string{"A", "B", "C"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTopoSort_Diamond(t *testing.T) {
	//   A
	//  / \
	// B   C
	//  \ /
	//   D
	deps := map[string][]string{
		"A": {},
		"B": {"A"},
		"C": {"A"},
		"D": {"B", "C"},
	}
	got := TopoSort([]string{"D", "C", "B", "A"}, func(id string) []string { return deps[id] })

	// A must come before B and C; B and C must come before D.
	idx := make(map[string]int, len(got))
	for i, id := range got {
		idx[id] = i
	}
	if idx["A"] >= idx["B"] || idx["A"] >= idx["C"] {
		t.Fatalf("A should precede B and C: %v", got)
	}
	if idx["B"] >= idx["D"] || idx["C"] >= idx["D"] {
		t.Fatalf("B and C should precede D: %v", got)
	}
}

func TestTopoSort_DepsOutsideSet(t *testing.T) {
	// B depends on X (not in set) and A. Only A is in the set.
	deps := map[string][]string{
		"A": {"X"},
		"B": {"A", "X"},
	}
	got := TopoSort([]string{"B", "A"}, func(id string) []string { return deps[id] })
	want := []string{"A", "B"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTopoSort_InputOrderTiebreak(t *testing.T) {
	// A, B, C have no deps between them. Input order should be preserved.
	got := TopoSort([]string{"C", "A", "B"}, func(string) []string { return nil })
	want := []string{"C", "A", "B"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTopoSort_MixedTopoAndInputOrder(t *testing.T) {
	// D depends on A. B and C are independent.
	// Input: D, B, C, A → topo level 0: B, C, A (input order); level 1: D
	deps := map[string][]string{
		"D": {"A"},
	}
	got := TopoSort([]string{"D", "B", "C", "A"}, func(id string) []string { return deps[id] })

	idx := make(map[string]int, len(got))
	for i, id := range got {
		idx[id] = i
	}
	if idx["A"] >= idx["D"] {
		t.Fatalf("A should precede D: %v", got)
	}
	// B and C should keep relative input order (B before C).
	if idx["B"] >= idx["C"] {
		t.Fatalf("B should precede C (input order tiebreak): %v", got)
	}
}

func TestTopoSort_Empty(t *testing.T) {
	got := TopoSort(nil, func(string) []string { return nil })
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestTopoSort_Single(t *testing.T) {
	got := TopoSort([]string{"X"}, func(string) []string { return nil })
	if !slices.Equal(got, []string{"X"}) {
		t.Fatalf("got %v, want [X]", got)
	}
}
