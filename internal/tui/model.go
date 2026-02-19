package tui

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/sprint"
	"github.com/jasjeetmavi/pod/internal/state"
	"github.com/jasjeetmavi/pod/internal/task"
)

const (
	panelBacklog = 0
	panelSprint  = 1
)

// Model is the main bubbletea model for the Pod TUI.
type Model struct {
	db       *state.DB
	store    *task.Store
	planner  *sprint.Planner
	executor *sprint.Executor
	cfg      *config.Config
	repoDir  string

	// UI state
	activePanel  int
	backlogItems []*task.Task
	sprintInfo   *sprint.Sprint
	sprintTasks  []*task.Task
	cursor       int
	message      string
	width        int
	height       int

	// Scroll offsets per panel
	backlogScroll int
	sprintScroll  int

	// Input mode
	inputMode  bool
	inputField string // "add", "edit"
	inputValue string
	editTaskID string // task being edited

	// Sprint running state
	sprintRunning bool
}

// Init loads initial data from DB.
func (m *Model) Init() tea.Cmd {
	m.refresh()
	return nil
}

// Update handles all messages (keys, window resize, async results).
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case sprintStartMsg:
		m.sprintRunning = false
		if msg.err != nil {
			m.message = "Sprint error: " + msg.err.Error()
		} else {
			var ok, fail int
			for _, r := range msg.results {
				if r.Status == "completed" {
					ok++
				} else {
					fail++
				}
			}
			m.message = sprintf("Sprint done: %d ok, %d failed", ok, fail)
		}
		m.refresh()
		return m, nil

	case integrateMsg:
		if msg.err != nil {
			m.message = "Integrate error: " + msg.err.Error()
		} else {
			m.message = sprintf("Integrated: %d merged, %d failed", len(msg.merged), len(msg.failed))
		}
		m.refresh()
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)
	}

	return m, nil
}

// refresh reloads all data from the DB.
func (m *Model) refresh() {
	tasks, err := m.store.List()
	if err != nil {
		m.message = "Error loading tasks: " + err.Error()
		return
	}

	m.backlogItems = nil
	for _, t := range tasks {
		if t.SprintID == "" {
			m.backlogItems = append(m.backlogItems, t)
		}
	}

	active, err := m.planner.GetActive()
	if err != nil {
		m.message = "Error loading sprint: " + err.Error()
		m.sprintInfo = nil
		m.sprintTasks = nil
		return
	}
	m.sprintInfo = active
	m.sprintTasks = nil

	if active != nil {
		for _, id := range active.TaskIDs {
			t, err := m.planner.GetTask(id)
			if err == nil {
				m.sprintTasks = append(m.sprintTasks, t)
			}
		}
	}

	// Clamp cursors
	m.clampCursor()
}

// activePanelLen returns the number of items in the currently active panel.
func (m *Model) activePanelLen() int {
	if m.activePanel == panelBacklog {
		return len(m.backlogItems)
	}
	return len(m.sprintTasks)
}

// clampCursor ensures cursor is within bounds.
func (m *Model) clampCursor() {
	max := m.activePanelLen() - 1
	if max < 0 {
		max = 0
	}
	if m.cursor > max {
		m.cursor = max
	}
}

// selectedTask returns the task under the cursor in the active panel.
func (m *Model) selectedTask() *task.Task {
	if m.activePanel == panelBacklog {
		if m.cursor < len(m.backlogItems) {
			return m.backlogItems[m.cursor]
		}
	} else {
		if m.cursor < len(m.sprintTasks) {
			return m.sprintTasks[m.cursor]
		}
	}
	return nil
}
