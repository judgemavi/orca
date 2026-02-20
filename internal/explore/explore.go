// Package explore runs a headless agent to analyze a codebase and produce a context file.
package explore

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/worker"
)

const contextFile = ".pod/context.md"

const metaPrompt = `Analyze this codebase and produce a concise context document in markdown. Include:

1. **Project overview** — what this project does, in 1-2 sentences
2. **Directory structure** — top-level layout with brief descriptions
3. **Key patterns** — architecture style, naming conventions, error handling patterns
4. **Dependencies** — major external deps and what they're used for
5. **Build/test** — how to build and test the project

Keep it under 500 lines. Focus on what another developer (or AI agent) needs to know to contribute effectively.`

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

	prompt := metaPrompt
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
