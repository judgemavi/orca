package tui

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/jasjeetmavi/pod/internal/task"
)

// handleKey processes key messages. Returns (model, cmd).
func (m *Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Input mode: capture into inputValue
	if m.inputMode {
		return m.handleInputKey(msg)
	}

	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit

	case "tab":
		if m.activePanel == panelBacklog {
			m.activePanel = panelSprint
		} else {
			m.activePanel = panelBacklog
		}
		m.cursor = 0
		m.clampCursor()

	case "j", "down":
		if m.cursor < m.activePanelLen()-1 {
			m.cursor++
		}

	case "k", "up":
		if m.cursor > 0 {
			m.cursor--
		}

	case "a":
		m.inputMode = true
		m.inputField = "add"
		m.inputValue = ""
		m.message = "New task title:"

	case "e":
		t := m.selectedTask()
		if t != nil && m.activePanel == panelBacklog {
			m.inputMode = true
			m.inputField = "edit"
			m.inputValue = t.Title
			m.editTaskID = t.ID
			m.message = "Edit title:"
		}

	case "d":
		t := m.selectedTask()
		if t != nil && m.activePanel == panelBacklog && t.Status == "pending" {
			if err := m.store.Delete(t.ID); err != nil {
				m.message = "Delete error: " + err.Error()
			} else {
				m.message = "Deleted: " + short(t.ID)
			}
			m.refresh()
		}

	case "t":
		t := m.selectedTask()
		if t != nil && m.activePanel == panelBacklog {
			m.cycleTool(t)
		}

	case "p":
		active, _ := m.planner.GetActive()
		if active != nil {
			m.message = sprintf("Sprint %s already active (%s)", short(active.ID), active.Status)
			return m, nil
		}
		s, err := m.planner.Plan(m.cfg.Workers.MaxParallel)
		if err != nil {
			m.message = "Plan error: " + err.Error()
		} else {
			m.message = sprintf("Planned sprint %s (%d tasks)", short(s.ID), len(s.TaskIDs))
		}
		m.refresh()

	case "s":
		if m.sprintRunning {
			m.message = "Sprint already running"
			return m, nil
		}
		if m.sprintInfo == nil {
			m.message = "No active sprint — press 'p' to plan first"
			return m, nil
		}
		if m.sprintInfo.Status != "planning" {
			m.message = sprintf("Sprint is %s, not planning", m.sprintInfo.Status)
			return m, nil
		}
		m.sprintRunning = true
		m.message = "Sprint running..."
		return m, startSprintCmd(m.executor, m.sprintInfo)

	case "r":
		if m.sprintInfo != nil {
			m.message = sprintf("Sprint %s — status: %s, %d tasks",
				short(m.sprintInfo.ID), m.sprintInfo.Status, len(m.sprintTasks))
		} else {
			m.message = "No active sprint"
		}

	case "i":
		m.message = "Integrating..."
		return m, integrateCmd(m.repoDir, m.cfg, m.planner)

	case "R":
		if m.sprintInfo == nil {
			m.message = "No active sprint to reset"
			return m, nil
		}
		if err := m.executor.Cleanup(m.sprintInfo); err != nil {
			m.message = "Cleanup warning: " + err.Error()
		}
		if err := m.planner.ResetSprintTasks(m.sprintInfo.ID); err != nil {
			m.message = "Reset error: " + err.Error()
		} else if err := m.planner.Fail(m.sprintInfo.ID); err != nil {
			m.message = "Fail error: " + err.Error()
		} else {
			m.message = "Sprint reset. Tasks reverted to pending."
		}
		m.refresh()
	}

	return m, nil
}

// handleInputKey processes keys when in input mode.
func (m *Model) handleInputKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "enter":
		m.inputMode = false
		m.commitInput()

	case "esc":
		m.inputMode = false
		m.inputValue = ""
		m.message = "Cancelled"

	case "backspace":
		if len(m.inputValue) > 0 {
			m.inputValue = m.inputValue[:len(m.inputValue)-1]
		}

	default:
		// Only single printable chars
		if len(msg.String()) == 1 || msg.String() == " " {
			m.inputValue += msg.String()
		}
	}

	return m, nil
}

// commitInput executes the pending input action.
func (m *Model) commitInput() {
	switch m.inputField {
	case "add":
		if m.inputValue == "" {
			m.message = "Empty title, cancelled"
			return
		}
		t, err := m.store.Create(m.inputValue, "", "", "")
		if err != nil {
			m.message = "Create error: " + err.Error()
		} else {
			m.message = sprintf("Created: %s %s", short(t.ID), t.Title)
		}
		m.refresh()

	case "edit":
		if m.inputValue == "" || m.editTaskID == "" {
			m.message = "Empty title, cancelled"
			return
		}
		err := m.store.Update(m.editTaskID, map[string]interface{}{"title": m.inputValue})
		if err != nil {
			m.message = "Update error: " + err.Error()
		} else {
			m.message = sprintf("Updated: %s", short(m.editTaskID))
		}
		m.editTaskID = ""
		m.refresh()
	}
}

// cycleTool cycles through configured tools for the selected task.
func (m *Model) cycleTool(t *task.Task) {
	toolNames := make([]string, 0, len(m.cfg.Tools))
	for name := range m.cfg.Tools {
		toolNames = append(toolNames, name)
	}
	if len(toolNames) == 0 {
		m.message = "No tools configured"
		return
	}

	// Find current index, advance to next
	current := -1
	for i, name := range toolNames {
		if name == t.AssignedTool {
			current = i
			break
		}
	}
	next := (current + 1) % len(toolNames)
	newTool := toolNames[next]

	err := m.store.Update(t.ID, map[string]interface{}{"assigned_tool": newTool})
	if err != nil {
		m.message = "Tool assign error: " + err.Error()
	} else {
		m.message = sprintf("Assigned %s to %s", newTool, short(t.ID))
	}
	m.refresh()
}

// short returns the first 8 chars of an ID.
func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
