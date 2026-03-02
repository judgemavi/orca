// Package breakdown uses an LLM to break down a goal into a structured task list.
package breakdown

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

type ProposedTask struct {
	Title            string `json:"title"`
	Description      string `json:"description"`
	DependsOnIndices []int  `json:"depends_on_indices"`
	SuggestedTool    string `json:"suggested_tool"`
}

type Breaker struct {
	toolName     string
	driver       driver.Driver
	model        string
	timeout      time.Duration
	repoDir      string
	interactions *interaction.Store
}

func New(toolName string, d driver.Driver, model string, timeout time.Duration, repoDir string, interactions ...*interaction.Store) *Breaker {
	var store *interaction.Store
	if len(interactions) > 0 {
		store = interactions[0]
	}
	return &Breaker{toolName: toolName, driver: d, model: model, timeout: timeout, repoDir: repoDir, interactions: store}
}

func (b *Breaker) Run(taskID *string, goal string) ([]ProposedTask, string, error) {
	contextSection := ""
	if ctx := explore.LoadContext(b.repoDir); ctx != "" {
		contextSection = "## Codebase Context\n\n" + ctx + "\n\n"
	}
	prompt := fmt.Sprintf(prompts.Breakdown, contextSection, goal)

	adapter := worker.NewAdapter(b.driver, b.model, b.timeout)

	interactionID := ""
	result, err := interaction.RunWithTracking(
		b.interactions,
		taskID,
		interaction.PhaseBreakdown,
		b.toolName,
		adapter,
		func() (*worker.Result, error) {
			return adapter.Execute(context.Background(), interaction.PhaseBreakdown, prompt, b.repoDir)
		},
		interaction.WithOnBegin(func(w *interaction.Writer) {
			interactionID = w.ID()
		}),
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
				opts = append(opts, interaction.WithError(fmt.Sprintf("breaker exited %d: %s", exitCode, stderr)))
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
		return nil, interactionID, fmt.Errorf("execute breaker: %w", err)
	}
	if exitCode != 0 {
		return nil, interactionID, fmt.Errorf("breaker exited %d: %s", exitCode, stderr)
	}

	output := stdout
	tasks, err := parseProposedTasks(output)
	if err != nil {
		return nil, interactionID, fmt.Errorf("parse task breakdown: %w\nraw output:\n%s", err, output)
	}
	return tasks, interactionID, nil
}

var (
	taskHeaderRe    = regexp.MustCompile(`(?i)^###\s*task\s+(\d+)(?::\s*(.*))?$`)
	listFieldLineRe = regexp.MustCompile(`^-+\s*([A-Za-z ]+)\s*:\s*(.*)$`)
)

func parseProposedTasks(output string) ([]ProposedTask, error) {
	return parseMarkdownProposedTasks(output)
}

func parseMarkdownProposedTasks(output string) ([]ProposedTask, error) {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) == 0 {
		return nil, fmt.Errorf("empty response")
	}

	tasks := make([]ProposedTask, 0, 8)
	current := ProposedTask{}
	inTask := false
	appendCurrent := func() {
		if !inTask {
			return
		}
		current.Title = strings.TrimSpace(current.Title)
		current.Description = strings.TrimSpace(current.Description)
		if current.Title == "" && current.Description == "" {
			return
		}
		if current.Title == "" {
			current.Title = "Task"
		}
		if current.Description == "" {
			current.Description = current.Title
		}
		current.SuggestedTool = normalizeSuggestedTool(current.SuggestedTool)
		current.DependsOnIndices = normalizeDependsOn(current.DependsOnIndices)
		tasks = append(tasks, current)
	}

	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}

		if m := taskHeaderRe.FindStringSubmatch(line); m != nil {
			appendCurrent()
			current = ProposedTask{}
			inTask = true
			if len(m) > 2 && strings.TrimSpace(m[2]) != "" {
				current.Title = strings.TrimSpace(m[2])
			}
			continue
		}
		if !inTask {
			continue
		}

		if m := listFieldLineRe.FindStringSubmatch(line); m != nil {
			key := strings.ToLower(strings.TrimSpace(m[1]))
			value := strings.TrimSpace(m[2])
			switch key {
			case "title":
				current.Title = value
			case "description":
				current.Description = value
			case "depends on":
				current.DependsOnIndices = parseDependsOnNumbers(value)
			case "suggested tool":
				current.SuggestedTool = value
			}
		}
	}
	appendCurrent()

	if len(tasks) == 0 {
		return nil, fmt.Errorf("no tasks found in markdown response")
	}
	return normalizeProposedTasks(tasks), nil
}

func parseDependsOnNumbers(raw string) []int {
	clean := strings.TrimSpace(strings.ToLower(raw))
	if clean == "" || clean == "none" || clean == "n/a" {
		return nil
	}
	parts := strings.FieldsFunc(clean, func(r rune) bool {
		return r == ',' || r == ' ' || r == ';'
	})
	out := make([]int, 0, len(parts))
	for _, part := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n <= 0 {
			continue
		}
		out = append(out, n-1) // markdown template is 1-based
	}
	return out
}

func normalizeSuggestedTool(tool string) string {
	switch strings.ToLower(strings.TrimSpace(tool)) {
	case "claude", "codex":
		return strings.ToLower(strings.TrimSpace(tool))
	default:
		return ""
	}
}

func normalizeDependsOn(deps []int) []int {
	if len(deps) == 0 {
		return nil
	}
	seen := make(map[int]struct{}, len(deps))
	out := make([]int, 0, len(deps))
	for _, dep := range deps {
		if dep < 0 {
			continue
		}
		if _, ok := seen[dep]; ok {
			continue
		}
		seen[dep] = struct{}{}
		out = append(out, dep)
	}
	return out
}

func normalizeProposedTasks(tasks []ProposedTask) []ProposedTask {
	out := make([]ProposedTask, 0, len(tasks))
	for _, task := range tasks {
		title := strings.TrimSpace(task.Title)
		description := strings.TrimSpace(task.Description)
		if title == "" && description == "" {
			continue
		}
		if title == "" {
			title = "Task"
		}
		if description == "" {
			description = title
		}
		out = append(out, ProposedTask{
			Title:            title,
			Description:      description,
			DependsOnIndices: normalizeDependsOn(task.DependsOnIndices),
			SuggestedTool:    normalizeSuggestedTool(task.SuggestedTool),
		})
	}
	return out
}
