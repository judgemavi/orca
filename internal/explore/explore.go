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

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

const contextFile = ".orca/context.md"

type Explorer struct {
	toolName     string
	driver       driver.Driver
	model        string
	timeout      time.Duration
	repoDir      string
	goal         string
	interactions *interaction.Store
}

func New(toolName string, d driver.Driver, model string, timeout time.Duration, repoDir string, interactions ...*interaction.Store) *Explorer {
	var store *interaction.Store
	if len(interactions) > 0 {
		store = interactions[0]
	}
	return &Explorer{toolName: toolName, driver: d, model: model, timeout: timeout, repoDir: repoDir, interactions: store}
}

func (e *Explorer) WithGoal(goal string) *Explorer {
	e.goal = goal
	return e
}

func (e *Explorer) Run() (string, error) {
	adapter := worker.NewAdapter(e.driver, e.model, e.timeout)

	prompt := prompts.Explore
	if e.goal != "" {
		prompt += "\n\n## User Goal\n\n" + e.goal + "\n\nIncorporate this goal into your analysis - note what exists that supports it and what's missing."
	}

	var writer *interaction.Writer
	if e.interactions != nil {
		w, beginErr := e.interactions.Begin(nil, "explore", e.toolName)
		if beginErr == nil {
			writer = w
		}
	}
	var (
		outputCh   chan worker.OutputLine
		outputDone chan struct{}
	)
	if writer != nil {
		outputCh = make(chan worker.OutputLine, 256)
		outputDone = make(chan struct{})
		adapter.SetOutputChan(outputCh)
		go func() {
			defer close(outputDone)
			for line := range outputCh {
				if line.Stream == "raw" {
					_ = writer.WriteString(line.Line + "\n")
				}
			}
		}()
	}

	result, err := adapter.Execute(context.Background(), "explore", prompt, e.repoDir)
	if outputCh != nil {
		close(outputCh)
		<-outputDone
	}
	stdout := ""
	exitCode := -1
	stderr := ""
	if result != nil {
		stdout = result.Stdout
		exitCode = result.ExitCode
		stderr = result.Stderr
	}
	if writer != nil {
		status := "completed"
		opts := []interaction.FinishOption{}
		if result != nil {
			opts = append(opts, interaction.WithCost(result.InputTokens, result.OutputTokens, result.TotalCost))
		}
		if err != nil {
			status = "failed"
			opts = append(opts, interaction.WithError(err.Error()))
		} else if exitCode != 0 {
			status = "failed"
			opts = append(opts, interaction.WithError(fmt.Sprintf("explorer exited %d: %s", exitCode, stderr)))
		}
		_ = e.interactions.Finish(writer.ID(), status, opts...)
		_ = writer.Close()
	}
	if err != nil {
		return "", fmt.Errorf("execute explorer: %w", err)
	}
	if exitCode != 0 {
		return "", fmt.Errorf("explorer exited %d: stderr=%s stdout=%s", exitCode, truncate(stderr, 500), truncate(stdout, 500))
	}

	content := stdout
	outPath := filepath.Join(e.repoDir, contextFile)
	if err := os.WriteFile(outPath, []byte(content), 0644); err != nil {
		return "", fmt.Errorf("write context: %w", err)
	}
	hash, _ := hashFileTree(e.repoDir)
	if hash != "" {
		_ = os.WriteFile(filepath.Join(e.repoDir, ".orca/context.hash"), []byte(hash), 0644)
	}

	return outPath, nil
}

func ContextPath(repoDir string) string {
	return filepath.Join(repoDir, contextFile)
}

func LoadContext(repoDir string) string {
	data, err := os.ReadFile(ContextPath(repoDir))
	if err != nil {
		return ""
	}
	return string(data)
}

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
		_ = os.WriteFile(filepath.Join(repoDir, ".orca/context.hash"), []byte(hash), 0644)
	}
	return outPath, nil
}

func WriteManualContextFromFile(repoDir, sourcePath string) (string, error) {
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return "", fmt.Errorf("read source: %w", err)
	}
	return WriteManualContext(repoDir, string(data))
}

func IsStale(repoDir string) (bool, error) {
	hashPath := filepath.Join(repoDir, ".orca/context.hash")
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

func ContextAge(repoDir string) time.Duration {
	info, err := os.Stat(ContextPath(repoDir))
	if err != nil {
		return 0
	}
	return time.Since(info.ModTime())
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
