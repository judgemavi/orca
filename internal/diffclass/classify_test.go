package diffclass

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestClassifyDiff(t *testing.T) {
	t.Parallel()

	cfg := Config{
		MinorMaxLines:  20,
		MediumMaxLines: 100,
	}

	tests := []struct {
		name string
		stat DiffStat
		want ChangeType
	}{
		{
			name: "deleted",
			stat: DiffStat{Status: "D", LinesAdded: 0, LinesRemoved: 0},
			want: ChangeDeleted,
		},
		{
			name: "renamed",
			stat: DiffStat{Status: "R", LinesAdded: 3, LinesRemoved: 3},
			want: ChangeRenamed,
		},
		{
			name: "minor",
			stat: DiffStat{Status: "M", LinesAdded: 5, LinesRemoved: 4},
			want: ChangeMinor,
		},
		{
			name: "medium at threshold",
			stat: DiffStat{Status: "M", LinesAdded: 20, LinesRemoved: 0},
			want: ChangeMedium,
		},
		{
			name: "major",
			stat: DiffStat{Status: "M", LinesAdded: 60, LinesRemoved: 60},
			want: ChangeMajor,
		},
		{
			name: "binary unknown treated major",
			stat: DiffStat{Status: "M", LinesAdded: -1, LinesRemoved: -1},
			want: ChangeMajor,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := ClassifyDiffWithConfig(tc.stat, cfg)
			if got != tc.want {
				t.Fatalf("ClassifyDiffWithConfig(%+v) = %q, want %q", tc.stat, got, tc.want)
			}
		})
	}
}

func TestDiffStatsBetween(t *testing.T) {
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"internal/a.go":    "package main\n\nfunc a() int { return 1 }\n",
		"internal/old.go":  "package main\n\nfunc old() {}\n",
		"internal/gone.go": "package main\n",
	})

	base := gitOutput(t, repoDir, "rev-parse", "HEAD")

	writeRepoFile(t, repoDir, "internal/a.go", "package main\n\nfunc a() int { return 2 }\n")
	if err := os.MkdirAll(filepath.Join(repoDir, "internal", "renamed"), 0o755); err != nil {
		t.Fatalf("mkdir renamed dir: %v", err)
	}
	runGit(t, repoDir, "mv", "internal/old.go", "internal/renamed/new.go")
	if err := os.Remove(filepath.Join(repoDir, "internal", "gone.go")); err != nil {
		t.Fatalf("remove gone.go: %v", err)
	}
	runGit(t, repoDir, "add", "-A")
	runGit(t, repoDir, "commit", "-m", "modify rename delete")
	head := gitOutput(t, repoDir, "rev-parse", "HEAD")

	stats, err := DiffStatsBetween(repoDir, base, head)
	if err != nil {
		t.Fatalf("DiffStatsBetween: %v", err)
	}
	if len(stats) != 3 {
		t.Fatalf("len(stats) = %d, want 3", len(stats))
	}

	byPath := make(map[string]DiffStat, len(stats))
	for _, stat := range stats {
		byPath[stat.FilePath] = stat
	}

	modified, ok := byPath["internal/a.go"]
	if !ok {
		t.Fatalf("missing modified file stat")
	}
	if modified.Status != "M" {
		t.Fatalf("modified status = %q, want M", modified.Status)
	}
	if modified.LinesAdded+modified.LinesRemoved == 0 {
		t.Fatalf("modified line counts missing: %+v", modified)
	}

	renamed, ok := byPath["internal/old.go"]
	if !ok {
		t.Fatalf("missing renamed source file stat")
	}
	if renamed.Status != "R" {
		t.Fatalf("renamed status = %q, want R", renamed.Status)
	}
	if renamed.NewPath != "internal/renamed/new.go" {
		t.Fatalf("renamed new_path = %q, want internal/renamed/new.go", renamed.NewPath)
	}

	deleted, ok := byPath["internal/gone.go"]
	if !ok {
		t.Fatalf("missing deleted file stat")
	}
	if deleted.Status != "D" {
		t.Fatalf("deleted status = %q, want D", deleted.Status)
	}
}

func initGitRepoWithCommit(t *testing.T, files map[string]string) string {
	t.Helper()
	repoDir := t.TempDir()
	runGit(t, repoDir, "init")
	runGit(t, repoDir, "config", "user.email", "test@example.com")
	runGit(t, repoDir, "config", "user.name", "Orca Test")
	for path, content := range files {
		writeRepoFile(t, repoDir, path, content)
	}
	args := []string{"add"}
	for path := range files {
		args = append(args, path)
	}
	runGit(t, repoDir, args...)
	runGit(t, repoDir, "commit", "-m", "init")
	return repoDir
}

func writeRepoFile(t *testing.T, repoDir, relPath, content string) {
	t.Helper()
	fullPath := filepath.Join(repoDir, relPath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", relPath, err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", relPath, err)
	}
}

func runGit(t *testing.T, repoDir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
	}
}

func gitOutput(t *testing.T, repoDir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
	}
	return string(bytesTrimSpace(out))
}

func bytesTrimSpace(b []byte) []byte {
	start := 0
	for start < len(b) && (b[start] == ' ' || b[start] == '\n' || b[start] == '\t' || b[start] == '\r') {
		start++
	}
	end := len(b)
	for end > start && (b[end-1] == ' ' || b[end-1] == '\n' || b[end-1] == '\t' || b[end-1] == '\r') {
		end--
	}
	return b[start:end]
}
