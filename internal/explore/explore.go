// Package explore runs a headless agent to analyze a codebase and persist context in SQLite.
package explore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

const stateDBFile = ".orca/state.db"
const exploreContextRowID = 1
const NoTrackedCodeMessage = "No meaningful tracked source files found. Add source files first, then run explore."

type Explorer struct {
	toolName     string
	driver       driver.Driver
	model        string
	timeout      time.Duration
	repoDir      string
	goal         string
	interactions *interaction.Store
}

var nonCodeTrackedFiles = map[string]struct{}{
	".gitignore":        {},
	".gitattributes":    {},
	".gitmodules":       {},
	".editorconfig":     {},
	"LICENSE":           {},
	"LICENSE.md":        {},
	"LICENSE.txt":       {},
	"README":            {},
	"README.md":         {},
	"README.txt":        {},
	"go.mod":            {},
	"go.sum":            {},
	"package.json":      {},
	"package-lock.json": {},
	"pnpm-lock.yaml":    {},
	"yarn.lock":         {},
	"bun.lock":          {},
	"bun.lockb":         {},
	"Cargo.toml":        {},
	"Cargo.lock":        {},
	"pyproject.toml":    {},
	"requirements.txt":  {},
	"Pipfile":           {},
	"Pipfile.lock":      {},
	"Gemfile":           {},
	"Gemfile.lock":      {},
	"composer.json":     {},
	"composer.lock":     {},
}

func New(toolName string, d driver.Driver, model string, timeout time.Duration, repoDir string, interactions ...*interaction.Store) *Explorer {
	var store *interaction.Store
	if len(interactions) > 0 {
		store = interactions[0]
	}
	return &Explorer{toolName: toolName, driver: d, model: model, timeout: timeout, repoDir: repoDir, interactions: store}
}

// HasTrackedCode reports whether git tracks at least one meaningful source file.
// It excludes Orca runtime state (.orca/) and common config/documentation-only files.
func HasTrackedCode(repoDir string) (bool, error) {
	cmd := exec.Command("git", "ls-files")
	cmd.Dir = repoDir
	out, err := cmd.Output()
	if err != nil {
		return false, err
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines {
		file := strings.TrimSpace(line)
		if file == "" {
			continue
		}
		if isIgnoredForTrackedCodeCheck(file) {
			continue
		}
		return true, nil
	}
	return false, nil
}

func isIgnoredForTrackedCodeCheck(file string) bool {
	if strings.HasPrefix(file, ".orca/") || file == ".orca" {
		return true
	}
	base := filepath.Base(file)
	_, ignore := nonCodeTrackedFiles[base]
	return ignore
}

func (e *Explorer) Run() (string, error) {
	adapter := worker.NewAdapter(e.driver, e.model, e.timeout)

	prompt := prompts.Explore
	if e.goal != "" {
		prompt += "\n\n## User Goal\n\n" + e.goal + "\n\nIncorporate this goal into your analysis - note what exists that supports it and what's missing."
	}

	result, err := interaction.RunWithTracking(
		e.interactions,
		nil,
		interaction.PhaseExplore,
		e.toolName,
		adapter,
		func() (*worker.Result, error) {
			return adapter.Execute(context.Background(), interaction.PhaseExplore, prompt, e.repoDir)
		},
		interaction.WithFinishFn(func(result *worker.Result, runErr error) (string, []interaction.FinishOption) {
			status := "completed"
			opts := []interaction.FinishOption{}
			if result != nil {
				opts = append(opts, interaction.WithCost(result.InputTokens, result.OutputTokens, result.TotalCost))
			}
			if runErr != nil {
				status = "failed"
				opts = append(opts, interaction.WithError(runErr.Error()))
			} else if result == nil || result.ExitCode != 0 {
				status = "failed"
				exitCode := -1
				stderr := ""
				if result != nil {
					exitCode = result.ExitCode
					stderr = result.Stderr
				}
				opts = append(opts, interaction.WithError(fmt.Sprintf("explorer exited %d: %s", exitCode, stderr)))
			}
			return status, opts
		}),
	)
	stdout := ""
	exitCode := -1
	stderr := ""
	if result != nil {
		stdout = result.Stdout
		exitCode = result.ExitCode
		stderr = result.Stderr
	}
	if err != nil {
		return "", fmt.Errorf("execute explorer: %w", err)
	}
	if exitCode != 0 {
		return "", fmt.Errorf("explorer exited %d: stderr=%s stdout=%s", exitCode, truncate(stderr, 500), truncate(stdout, 500))
	}

	content := stdout
	outPath, err := persistContext(e.repoDir, content)
	if err != nil {
		return "", err
	}
	return outPath, nil
}

func LoadContext(repoDir string) string {
	dbPath := filepath.Join(repoDir, stateDBFile)
	if info, err := os.Stat(dbPath); err == nil && !info.IsDir() {
		db, err := openStateDB(repoDir)
		if err == nil {
			defer db.Close()
			return LoadContextFromDB(db)
		}
	}
	return ""
}

func LoadContextFromDB(db *state.DB) string {
	content, err := loadContextFromDB(db)
	if err != nil {
		return ""
	}
	return content
}

func WriteManualContext(repoDir, content string) (string, error) {
	return persistContext(repoDir, content)
}

func WriteManualContextFromFile(repoDir, sourcePath string) (string, error) {
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return "", fmt.Errorf("read source: %w", err)
	}
	return WriteManualContext(repoDir, string(data))
}

func IsStale(repoDir string) (bool, error) {
	dbPath := filepath.Join(repoDir, stateDBFile)
	if _, err := os.Stat(dbPath); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	db, err := openStateDB(repoDir)
	if err != nil {
		return false, nil
	}
	defer db.Close()

	stored, err := loadContextHashFromDB(db)
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(stored) == "" {
		return false, nil
	}
	current, err := hashFileTree(repoDir)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(stored) != current, nil
}

func ContextAge(repoDir string) time.Duration {
	dbPath := filepath.Join(repoDir, stateDBFile)
	if _, err := os.Stat(dbPath); err != nil {
		return 0
	}
	db, err := openStateDB(repoDir)
	if err != nil {
		return 0
	}
	defer db.Close()

	updatedAt, err := loadContextUpdatedAtFromDB(db)
	if err != nil || updatedAt.IsZero() {
		return 0
	}
	age := time.Since(updatedAt)
	if age < 0 {
		return 0
	}
	return age
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

func hashFileTree(repoDir string) (string, error) {
	cmd := exec.Command("git", "ls-files")
	cmd.Dir = repoDir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(out)
	return hex.EncodeToString(h[:]), nil
}

func persistContext(repoDir, content string) (string, error) {
	hash, _ := hashFileTree(repoDir)
	if err := writeContextToDB(repoDir, content, hash); err != nil {
		return "", err
	}
	return stateDBFile, nil
}

func loadContextFromDB(db *state.DB) (string, error) {
	if db == nil {
		return "", nil
	}
	var content string
	err := db.QueryRow(`SELECT content FROM explore_context WHERE id = ?`, exploreContextRowID).Scan(&content)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", err
	}
	if strings.TrimSpace(content) == "" {
		return "", nil
	}
	return content, nil
}

func loadContextHashFromDB(db *state.DB) (string, error) {
	if db == nil {
		return "", nil
	}
	var hash string
	err := db.QueryRow(`SELECT hash FROM explore_context WHERE id = ?`, exploreContextRowID).Scan(&hash)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(hash), nil
}

func loadContextUpdatedAtFromDB(db *state.DB) (time.Time, error) {
	if db == nil {
		return time.Time{}, nil
	}
	var updatedAt time.Time
	err := db.QueryRow(`SELECT updated_at FROM explore_context WHERE id = ?`, exploreContextRowID).Scan(&updatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return time.Time{}, nil
		}
		return time.Time{}, err
	}
	return updatedAt.UTC(), nil
}

func writeContextToDB(repoDir, content, hash string) error {
	dbPath := filepath.Join(repoDir, stateDBFile)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		return fmt.Errorf("create db dir: %w", err)
	}
	db, err := openStateDB(repoDir)
	if err != nil {
		return err
	}
	defer db.Close()

	_, err = db.Exec(
		`REPLACE INTO explore_context (id, content, hash, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
		exploreContextRowID,
		content,
		hash,
	)
	return err
}

func openStateDB(repoDir string) (*state.DB, error) {
	db, err := state.Open(filepath.Join(repoDir, stateDBFile))
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	return db, nil
}
