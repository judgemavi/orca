package treesitter

import "testing"

func TestClassifyChange_GoFormattingOnly(t *testing.T) {
	oldContent := []byte(`package a

func Sum(a int, b int) int {
	return a+b
}`)
	newContent := []byte(`package a

func Sum(a int, b int) int {
	return a + b
}`)
	got := ClassifyChange("sum.go", oldContent, newContent)
	if got.Type != ChangeNone {
		t.Fatalf("type = %q, want %q", got.Type, ChangeNone)
	}
}

func TestClassifyChange_GoBodyChange(t *testing.T) {
	oldContent := []byte(`package a

func Sum(a int, b int) int {
	return a+b
}`)
	newContent := []byte(`package a

func Sum(a int, b int) int {
	return a+b+1
}`)
	got := ClassifyChange("sum.go", oldContent, newContent)
	if got.Type != ChangeBody {
		t.Fatalf("type = %q, want %q", got.Type, ChangeBody)
	}
}

func TestClassifyChange_GoStructuralChange(t *testing.T) {
	oldContent := []byte(`package a

func Sum(a int, b int) int {
	return a+b
}`)
	newContent := []byte(`package a

func Sum(a int64, b int64) int64 {
	return a+b
}`)
	got := ClassifyChange("sum.go", oldContent, newContent)
	if got.Type != ChangeStructural {
		t.Fatalf("type = %q, want %q", got.Type, ChangeStructural)
	}
}

func TestClassifyChange_TSStructuralChange(t *testing.T) {
	oldContent := []byte(`interface User { id: string }`)
	newContent := []byte(`interface User { id: string; name: string }`)
	got := ClassifyChange("types.ts", oldContent, newContent)
	if got.Type != ChangeStructural {
		t.Fatalf("type = %q, want %q", got.Type, ChangeStructural)
	}
}

func TestClassifyChange_UnknownFallback(t *testing.T) {
	oldContent := []byte("a: 1\n")
	newContent := []byte("a: 2\n")
	got := ClassifyChange("config.yaml", oldContent, newContent)
	if got.Type != ChangeBody {
		t.Fatalf("type = %q, want %q", got.Type, ChangeBody)
	}
}

func TestClassifyChange_Deleted(t *testing.T) {
	oldContent := []byte("package a\n")
	got := ClassifyChange("a.go", oldContent, nil)
	if got.Type != ChangeDeleted {
		t.Fatalf("type = %q, want %q", got.Type, ChangeDeleted)
	}
}
