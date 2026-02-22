package quality

import (
	"strconv"
	"strings"
	"testing"
)

func TestAnalyzeScopeSmallFix(t *testing.T) {
	diff := strings.Join([]string{
		"diff --git a/internal/a.go b/internal/a.go",
		"--- a/internal/a.go",
		"+++ b/internal/a.go",
		"+line1",
		"+line2",
		"+line3",
		"+line4",
		"+line5",
		"-line6",
		"-line7",
		"-line8",
		"-line9",
		"-line10",
		"diff --git a/internal/a_test.go b/internal/a_test.go",
		"--- a/internal/a_test.go",
		"+++ b/internal/a_test.go",
	}, "\n")

	got := AnalyzeScope("T-1", "fix small bug", diff)

	if got.Excessive {
		t.Fatalf("Excessive = true, want false; flags=%v", got.Flags)
	}
	if len(got.Flags) != 0 {
		t.Fatalf("expected no flags, got %v", got.Flags)
	}
	if got.FilesChanged != 2 {
		t.Fatalf("FilesChanged = %d, want 2", got.FilesChanged)
	}
	if got.LinesChanged != 10 {
		t.Fatalf("LinesChanged = %d, want 10", got.LinesChanged)
	}
}

func TestAnalyzeScopeHugeFixTypoFlagsFileCount(t *testing.T) {
	var lines []string
	for i := 0; i < 20; i++ {
		file := "internal/pkg/file" + strconv.Itoa(i) + ".go"
		lines = append(lines,
			"diff --git a/"+file+" b/"+file,
			"--- a/"+file,
			"+++ b/"+file,
		)
	}
	for i := 0; i < 400; i++ {
		lines = append(lines, "+add line")
	}
	for i := 0; i < 400; i++ {
		lines = append(lines, "-remove line")
	}

	got := AnalyzeScope("T-2", "fix typo in parser", strings.Join(lines, "\n"))

	if !got.Excessive {
		t.Fatalf("Excessive = false, want true")
	}
	if got.FilesChanged != 20 {
		t.Fatalf("FilesChanged = %d, want 20", got.FilesChanged)
	}
	if got.LinesChanged != 800 {
		t.Fatalf("LinesChanged = %d, want 800", got.LinesChanged)
	}
	if !hasFlagContaining(got.Flags, "files changed") {
		t.Fatalf("expected file-count flag in %v", got.Flags)
	}
}

func TestAnalyzeScopeNoTestsMultiFile(t *testing.T) {
	var lines []string
	for i := 0; i < 5; i++ {
		file := "internal/quality/impl" + strconv.Itoa(i) + ".go"
		lines = append(lines,
			"diff --git a/"+file+" b/"+file,
			"--- a/"+file,
			"+++ b/"+file,
			"+change",
		)
	}

	got := AnalyzeScope("T-3", "implement analyzer", strings.Join(lines, "\n"))

	if !hasFlagContaining(got.Flags, "no tests added for multi-file change") {
		t.Fatalf("expected missing-tests flag in %v", got.Flags)
	}
}

func TestAnalyzeScopeManyDirectories(t *testing.T) {
	diff := strings.Join([]string{
		"diff --git a/internal/a.go b/internal/a.go",
		"--- a/internal/a.go",
		"+++ b/internal/a.go",
		"+x",
		"diff --git a/cmd/main.go b/cmd/main.go",
		"--- a/cmd/main.go",
		"+++ b/cmd/main.go",
		"+x",
		"diff --git a/web/app.ts b/web/app.ts",
		"--- a/web/app.ts",
		"+++ b/web/app.ts",
		"+x",
		"diff --git a/tasks/plan.md b/tasks/plan.md",
		"--- a/tasks/plan.md",
		"+++ b/tasks/plan.md",
		"+x",
	}, "\n")

	got := AnalyzeScope("T-4", "add cross-cutting changes", diff)

	if !hasFlagContaining(got.Flags, "changes span many directories") {
		t.Fatalf("expected many-directories flag in %v", got.Flags)
	}
}

func hasFlagContaining(flags []string, substring string) bool {
	for _, flag := range flags {
		if strings.Contains(flag, substring) {
			return true
		}
	}
	return false
}
