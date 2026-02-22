// Package explore runs a headless agent to analyze a codebase and produce a context file.
package explore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/worker"
	"github.com/jasjeetmavi/pod/prompts"
)

const contextFile = ".pod/context.md"

// Explorer runs a tool headlessly to map a codebase.
type Explorer struct {
	toolCfg config.ToolConfig
	repoDir string
	goal    string
}

// New creates an Explorer with the given tool config and repo directory.
func New(toolCfg config.ToolConfig, repoDir string) *Explorer {
	return &Explorer{toolCfg: toolCfg, repoDir: repoDir}
}

// WithGoal sets an optional user goal to guide exploration context.
func (e *Explorer) WithGoal(goal string) *Explorer {
	e.goal = goal
	return e
}

// Run executes the exploration and writes results to .pod/context.md.
func (e *Explorer) Run() (string, error) {
	adapter, err := worker.NewAdapter(e.toolCfg)
	if err != nil {
		return "", fmt.Errorf("create adapter: %w", err)
	}

	prompt := prompts.Explore
	if e.goal != "" {
		prompt += "\n\n## User Goal\n\n" + e.goal + "\n\nIncorporate this goal into your analysis - note what exists that supports it and what's missing."
	}

	result, err := adapter.Execute(context.Background(), "explore", prompt, e.repoDir)
	if err != nil {
		return "", fmt.Errorf("execute explorer: %w", err)
	}

	if result.ExitCode != 0 {
		return "", fmt.Errorf("explorer exited %d: %s", result.ExitCode, result.Stderr)
	}

	// Extract text from Claude JSON envelope if present.
	content := worker.ExtractClaudeResult(result.Stdout)

	outPath := filepath.Join(e.repoDir, contextFile)
	if err := os.WriteFile(outPath, []byte(content), 0644); err != nil {
		return "", fmt.Errorf("write context: %w", err)
	}
	hash, _ := hashFileTree(e.repoDir)
	if hash != "" {
		_ = os.WriteFile(filepath.Join(e.repoDir, ".pod/context.hash"), []byte(hash), 0644)
	}

	return outPath, nil
}

// ContextPath returns the expected context file path for a repo.
func ContextPath(repoDir string) string {
	return filepath.Join(repoDir, contextFile)
}

// LoadContext reads the context file if it exists. Returns empty string if not found.
func LoadContext(repoDir string) string {
	data, err := os.ReadFile(ContextPath(repoDir))
	if err != nil {
		return ""
	}
	return string(data)
}

// WriteManualContext writes user-provided content to the context file.
func WriteManualContext(repoDir, content string) (string, error) {
	outPath := ContextPath(repoDir)
	if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
		return "", fmt.Errorf("create dir: %w", err)
	}
	if err := os.WriteFile(outPath, []byte(content), 0644); err != nil {
		return "", fmt.Errorf("write context: %w", err)
	}
	hash, _ := hashFileTree(repoDir)
	if hash != "" {
		_ = os.WriteFile(filepath.Join(repoDir, ".pod/context.hash"), []byte(hash), 0644)
	}
	return outPath, nil
}

// WriteManualContextFromFile copies a file's contents to the context file.
func WriteManualContextFromFile(repoDir, sourcePath string) (string, error) {
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return "", fmt.Errorf("read source: %w", err)
	}
	return WriteManualContext(repoDir, string(data))
}

// IsStale returns true if the codebase file tree has changed since exploration.
// Returns false if no hash file exists (never explored = not stale, just missing).
func IsStale(repoDir string) (bool, error) {
	hashPath := filepath.Join(repoDir, ".pod/context.hash")
	stored, err := os.ReadFile(hashPath)
	if err != nil {
		return false, nil
	}
	current, err := hashFileTree(repoDir)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(stored)) != current, nil
}

// ContextAge returns how old the context file is. Returns 0 if not found.
func ContextAge(repoDir string) time.Duration {
	info, err := os.Stat(ContextPath(repoDir))
	if err != nil {
		return 0
	}
	return time.Since(info.ModTime())
}

// hashFileTree returns a sha256 hex digest of `git ls-files` output in repoDir.
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
