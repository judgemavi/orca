package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jasjeetmavi/pod/internal/task"
)

// Styles
var (
	headerStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("15"))

	pendingStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("245")) // dim
	runningStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("220")) // yellow
	completedStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("82"))  // green
	failedStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("196")) // red

	cursorStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("51")) // cyan
	messageStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("220"))
	hintStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	inputBarStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("51"))
)

// View renders the entire TUI screen.
func (m *Model) View() string {
	if m.width == 0 || m.height == 0 {
		return "Loading..."
	}

	// Reserve 2 lines for footer (hints + message)
	contentHeight := m.height - 3
	if contentHeight < 4 {
		contentHeight = 4
	}

	panelWidth := m.width / 2
	if panelWidth < 10 {
		panelWidth = 10
	}
	rightWidth := m.width - panelWidth

	leftPanel := m.renderBacklogPanel(panelWidth-2, contentHeight-2)
	rightPanel := m.renderSprintPanel(rightWidth-2, contentHeight-2)

	// Build bordered panels
	leftBorder := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(panelBorderColor(m.activePanel == panelBacklog)).
		Width(panelWidth - 2).
		Height(contentHeight - 2)

	rightBorder := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(panelBorderColor(m.activePanel == panelSprint)).
		Width(rightWidth - 2).
		Height(contentHeight - 2)

	body := lipgloss.JoinHorizontal(lipgloss.Top,
		leftBorder.Render(leftPanel),
		rightBorder.Render(rightPanel),
	)

	// Footer
	var footer string
	if m.inputMode {
		footer = inputBarStyle.Render(fmt.Sprintf("%s > %s_", m.message, m.inputValue))
	} else {
		hints := hintStyle.Render("[a]dd [d]el [e]dit [t]ool  [p]lan [s]tart [r]eview [i]ntegrate [R]eset  [Tab] switch  [q]uit")
		msg := ""
		if m.message != "" {
			msg = messageStyle.Render("> " + m.message)
		}
		footer = hints + "\n" + msg
	}

	return body + "\n" + footer
}

// renderBacklogPanel renders the left panel content.
func (m *Model) renderBacklogPanel(width, height int) string {
	var b strings.Builder

	title := headerStyle.Render("Backlog")
	b.WriteString(title + "\n")

	if len(m.backlogItems) == 0 {
		b.WriteString(pendingStyle.Render("  (empty)") + "\n")
		return b.String()
	}

	// Separate pending and completed
	var pending, completed []*task.Task
	for _, t := range m.backlogItems {
		if t.Status == "completed" {
			completed = append(completed, t)
		} else {
			pending = append(pending, t)
		}
	}

	// Visible area for tasks (minus header lines)
	visibleLines := height - 1
	if visibleLines < 1 {
		visibleLines = 1
	}

	idx := 0
	for _, t := range pending {
		line := m.renderTaskLine(t, idx, panelBacklog, width)
		b.WriteString(line + "\n")
		// Dep info
		if len(t.DependsOn) > 0 {
			deps := make([]string, len(t.DependsOn))
			for i, d := range t.DependsOn {
				deps[i] = short(d)
			}
			depLine := pendingStyle.Render(fmt.Sprintf("    depends on: %s", strings.Join(deps, ", ")))
			b.WriteString(depLine + "\n")
		}
		idx++
	}

	if len(completed) > 0 {
		b.WriteString(headerStyle.Render("Completed") + "\n")
		for _, t := range completed {
			line := m.renderTaskLine(t, idx, panelBacklog, width)
			b.WriteString(line + "\n")
			idx++
		}
	}

	return b.String()
}

// renderSprintPanel renders the right panel content.
func (m *Model) renderSprintPanel(width, height int) string {
	var b strings.Builder

	if m.sprintInfo == nil {
		title := headerStyle.Render("Sprint")
		b.WriteString(title + "\n")
		b.WriteString(pendingStyle.Render("  (no active sprint)") + "\n")
		return b.String()
	}

	statusLabel := m.sprintInfo.Status
	if m.sprintRunning {
		statusLabel = "running"
	}
	title := headerStyle.Render(fmt.Sprintf("Sprint %s (%s)", short(m.sprintInfo.ID), statusLabel))
	b.WriteString(title + "\n")

	if len(m.sprintTasks) == 0 {
		b.WriteString(pendingStyle.Render("  (no tasks)") + "\n")
		return b.String()
	}

	for i, t := range m.sprintTasks {
		line := m.renderTaskLine(t, i, panelSprint, width)
		b.WriteString(line + "\n")

		statusLine := "    status: " + t.Status
		if t.AssignedTool != "" {
			statusLine += "  tool: " + t.AssignedTool
		}
		b.WriteString(styleForStatus(t.Status).Render(statusLine) + "\n")
	}

	return b.String()
}

// renderTaskLine renders a single task line with cursor highlight.
func (m *Model) renderTaskLine(t *task.Task, idx int, panel int, width int) string {
	icon := statusIcon(t.Status)
	prefix := "  "
	if m.activePanel == panel && m.cursor == idx {
		prefix = cursorStyle.Render("> ")
	}

	text := fmt.Sprintf("%s %s  %s", icon, short(t.ID), t.Title)

	// Truncate to fit panel width
	if len(text) > width-3 {
		text = text[:width-6] + "..."
	}

	style := styleForStatus(t.Status)
	return prefix + style.Render(text)
}

// statusIcon returns a unicode icon for the task status.
func statusIcon(status string) string {
	switch status {
	case "completed":
		return completedStyle.Render("\u2713")
	case "running", "in_sprint":
		return runningStyle.Render("\u25cf")
	case "failed":
		return failedStyle.Render("\u2717")
	default:
		return pendingStyle.Render("\u25cb")
	}
}

// styleForStatus returns the appropriate lipgloss style.
func styleForStatus(status string) lipgloss.Style {
	switch status {
	case "completed":
		return completedStyle
	case "running", "in_sprint":
		return runningStyle
	case "failed":
		return failedStyle
	default:
		return pendingStyle
	}
}

// panelBorderColor returns the border color based on whether the panel is active.
func panelBorderColor(active bool) lipgloss.Color {
	if active {
		return lipgloss.Color("51") // cyan
	}
	return lipgloss.Color("240") // gray
}
