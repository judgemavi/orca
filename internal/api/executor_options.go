package api

import (
	"log/slog"
	"time"

	"github.com/jasjeetmavi/orca/internal/sprint"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worker"
)

// NewExecutorOptions builds sprint executor hooks that broadcast worker and task
// lifecycle events through the API websocket hub.
func NewExecutorOptions(db *state.DB, hub *Hub) sprint.ExecutorOptions {
	return sprint.ExecutorOptions{
		OutputHook: func(line worker.OutputLine) {
			hub.Broadcast(Event{
				Type: "worker.output",
				Data: map[string]interface{}{
					"task_id": line.TaskID,
					"stream":  line.Stream,
					"line":    line.Line,
					"ts":      line.Time.UTC().Format(time.RFC3339Nano),
				},
			})
		},
		DoneHook: func(taskID string, exitCode int) {
			hub.Broadcast(Event{
				Type: "worker.done",
				Data: map[string]interface{}{
					"task_id":   taskID,
					"exit_code": exitCode,
				},
			})
			hub.Broadcast(Event{
				Type: "worker.output.end",
				Data: map[string]interface{}{
					"task_id": taskID,
					"ts":      time.Now().UTC().Format(time.RFC3339Nano),
				},
			})
		},
		BroadcastHook: func(taskID, status string) {
			store := task.NewStore(db)
			updated, err := store.Get(taskID)
			if err != nil {
				slog.Warn("broadcast task update load failed", "task_id", taskID, "status", status, "err", err)
				hub.Broadcast(Event{Type: "task.updated", Data: map[string]string{"id": taskID}})
				return
			}
			hub.Broadcast(Event{Type: "task.updated", Data: updated})
		},
	}
}
