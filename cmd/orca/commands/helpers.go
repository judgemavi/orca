package commands

import (
	"fmt"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/task"
)

func statusIcon(status string) string {
	switch status {
	case "approved":
		return "✓"
	case "broken_down":
		return "◈"
	case "running":
		return "●"
	case "failed":
		return "✗"
	default:
		return "○"
	}
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func statusFilter(statuses ...string) func(*task.Task) bool {
	if len(statuses) == 0 {
		return func(_ *task.Task) bool { return true }
	}
	allowed := make(map[string]struct{}, len(statuses))
	for _, status := range statuses {
		allowed[status] = struct{}{}
	}
	return func(t *task.Task) bool {
		_, ok := allowed[t.Status]
		return ok
	}
}

func pickTask(store *task.Store, title string, filter func(*task.Task) bool) (string, error) {
	tasks, err := store.List()
	if err != nil {
		return "", err
	}

	opts := make([]huh.Option[string], 0, len(tasks))
	for _, t := range tasks {
		if !filter(t) {
			continue
		}
		label := fmt.Sprintf("%s  %s (%s)", short(t.ID), t.Title, t.Status)
		opts = append(opts, huh.NewOption(label, t.ID))
	}
	if len(opts) == 0 {
		return "", fmt.Errorf("no tasks found")
	}

	var selected string
	if err := huh.NewSelect[string]().Title(title).Options(opts...).Value(&selected).Run(); err != nil {
		return "", err
	}
	return selected, nil
}

func resolveTaskID(store *task.Store, prefix string) (string, error) {
	id, err := store.ResolveID(prefix)
	if err != nil {
		return "", fmt.Errorf("resolve %q: %w", prefix, err)
	}
	return id, nil
}

func renderSpinner(label string, done <-chan struct{}) {
	frames := []rune{'|', '/', '-', '\\'}
	i := 0
	for {
		select {
		case <-done:
			fmt.Printf("\r%s... done\n", label)
			return
		default:
			fmt.Printf("\r%s... %c", label, frames[i%len(frames)])
			time.Sleep(120 * time.Millisecond)
			i++
		}
	}
}

func formatTokens(n int64) string {
	if n >= 1_000_000 {
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
	if n >= 1_000 {
		return formatWithCommas(n)
	}
	return fmt.Sprintf("%d", n)
}

func formatWithCommas(n int64) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var result []byte
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			result = append(result, ',')
		}
		result = append(result, byte(c))
	}
	return string(result)
}
