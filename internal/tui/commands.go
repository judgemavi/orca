package tui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/integrator"
	"github.com/jasjeetmavi/pod/internal/sprint"
)

// sprintStartMsg is sent when async sprint execution completes.
type sprintStartMsg struct {
	results []sprint.TaskResult
	err     error
}

// integrateMsg is sent when async integration completes.
type integrateMsg struct {
	merged []string
	failed []string
	err    error
}

// startSprintCmd runs the executor in a goroutine and returns a sprintStartMsg.
func startSprintCmd(executor *sprint.Executor, s *sprint.Sprint) tea.Cmd {
	return func() tea.Msg {
		results, err := executor.Run(s)
		return sprintStartMsg{results: results, err: err}
	}
}

// integrateCmd runs integration in a goroutine and returns an integrateMsg.
func integrateCmd(repoDir string, cfg *config.Config, planner *sprint.Planner) tea.Cmd {
	return func() tea.Msg {
		// Find the most recent completed/failed sprint.
		var sprintID string
		err := planner.DB().QueryRow(
			`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`,
		).Scan(&sprintID)
		if err != nil {
			return integrateMsg{err: fmt.Errorf("no completed sprint to integrate")}
		}

		s, err := planner.Get(sprintID)
		if err != nil {
			return integrateMsg{err: err}
		}

		var taskIDs []string
		for _, id := range s.TaskIDs {
			t, err := planner.GetTask(id)
			if err == nil && t.Status == "completed" {
				taskIDs = append(taskIDs, id)
			}
		}

		if len(taskIDs) == 0 {
			return integrateMsg{err: fmt.Errorf("no completed tasks to integrate")}
		}

		ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)
		merged, failed, err := ig.MergeBatch(taskIDs)
		return integrateMsg{merged: merged, failed: failed, err: err}
	}
}

// sprintf is a shorthand for fmt.Sprintf.
func sprintf(format string, a ...interface{}) string {
	return fmt.Sprintf(format, a...)
}
