package explore

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestIsStaleFalseAfterManualContextWrite(t *testing.T) {
	repoDir := initTempGitRepo(t)

	if _, err := WriteManualContext(repoDir, "context"); err != nil {
		t.Fatalf("WriteManualContext() error = %v", err)
	}

	stale, err := IsStale(repoDir)
	if err != nil {
		t.Fatalf("IsStale() error = %v", err)
	}
	if stale {
		t.Fatal("IsStale() = true, want false")
	}
}

func TestIsStaleTrueAfterTrackedFileTreeChange(t *testing.T) {
	repoDir := initTempGitRepo(t)

	if _, err := WriteManualContext(repoDir, "context"); err != nil {
		t.Fatalf("WriteManualContext() error = %v", err)
	}

	newPath := filepath.Join(repoDir, "new.txt")
	if err := os.WriteFile(newPath, []byte("new"), 0644); err != nil {
		t.Fatalf("WriteFile(new.txt) error = %v", err)
	}
	runGit(t, repoDir, "add", "new.txt")

	stale, err := IsStale(repoDir)
	if err != nil {
		t.Fatalf("IsStale() error = %v", err)
	}
	if !stale {
		t.Fatal("IsStale() = false, want true")
	}
}

func TestIsStaleFalseWhenHashMissing(t *testing.T) {
	repoDir := initTempGitRepo(t)

	stale, err := IsStale(repoDir)
	if err != nil {
		t.Fatalf("IsStale() error = %v", err)
	}
	if stale {
		t.Fatal("IsStale() = true, want false when hash is missing")
	}
}

func TestContextAgeNonZeroWhenContextExists(t *testing.T) {
	repoDir := initTempGitRepo(t)

	if _, err := WriteManualContext(repoDir, "context"); err != nil {
		t.Fatalf("WriteManualContext() error = %v", err)
	}

	age := ContextAge(repoDir)
	if age <= 0 {
		t.Fatalf("ContextAge() = %v, want > 0", age)
	}
}

func initTempGitRepo(t *testing.T) string {
	t.Helper()

	repoDir := t.TempDir()
	runGit(t, repoDir, "init")

	readme := filepath.Join(repoDir, "README.md")
	if err := os.WriteFile(readme, []byte("hello"), 0644); err != nil {
		t.Fatalf("WriteFile(README.md) error = %v", err)
	}
	runGit(t, repoDir, "add", "README.md")

	return repoDir
}

func runGit(t *testing.T, repoDir string, args ...string) {
	t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v; output: %s", args, err, string(out))
	}
}
