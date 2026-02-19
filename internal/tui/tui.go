// Package tui provides an interactive terminal UI for Pod using bubbletea.
package tui

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/sprint"
	"github.com/jasjeetmavi/pod/internal/state"
	"github.com/jasjeetmavi/pod/internal/task"
)

// New creates a new TUI model wired to the given runtime dependencies.
func New(db *state.DB, cfg *config.Config, planner *sprint.Planner,
	executor *sprint.Executor, repoDir string) *Model {

	store := task.NewStore(db)
	m := &Model{
		db:       db,
		store:    store,
		planner:  planner,
		executor: executor,
		cfg:      cfg,
		repoDir:  repoDir,
	}
	return m
}

// Run starts the bubbletea program in alt-screen mode.
func Run(m *Model) error {
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err := p.Run()
	return err
}
