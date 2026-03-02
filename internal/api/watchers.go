package api

import (
	"context"
	"database/sql"
	"log/slog"

	"github.com/jasjeetmavi/orca/internal/pty"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
)

// setupWatchers creates DB change watchers and event hooks that broadcast
// real-time updates to WebSocket clients.
func (s *Server) setupWatchers(ctx context.Context, taskStore *task.Store) {
	watcher := state.NewWatcher(s.db, state.WatcherCallbacks{
		OnTaskChange:        s.newTaskChangeHandler(taskStore),
		OnInteractionChange: s.handleInteractionChanges,
		OnSessionChange:     s.handleSessionChanges,
	}, state.WatcherOpts{})
	go watcher.Run(ctx)

	if err := s.interactions.MarkStaleAsFailed(); err != nil {
		slog.Error("mark stale interactions failed", "err", err)
	}

	if s.sessionMgr != nil {
		s.sessionMgr.SetEventHook(func(eventType string, sess *pty.Session) {
			s.hub.Broadcast(Event{
				Type: eventType,
				Data: map[string]interface{}{
					"id":        sess.ID,
					"type":      string(sess.Type),
					"tool":      sess.Tool,
					"task_id":   sess.TaskID,
					"exit_code": sess.ExitCode,
				},
			})
		})
	}
}

// newTaskChangeHandler returns a callback that broadcasts task changes.
// taskStore is passed as a param since it's not stored on the Server struct.
func (s *Server) newTaskChangeHandler(taskStore *task.Store) func([]state.TaskChange) {
	return func(changes []state.TaskChange) {
		for _, c := range changes {
			switch c.Type {
			case state.ChangeCreated:
				t, err := taskStore.Get(c.TaskID)
				if err == nil {
					s.hub.Broadcast(Event{Type: "task.created", Data: t})
				}
			case state.ChangeUpdated:
				t, err := taskStore.Get(c.TaskID)
				if err == nil {
					s.hub.Broadcast(Event{Type: "task.updated", Data: t})
				}
			case state.ChangeDeleted:
				s.hub.Broadcast(Event{Type: "task.deleted", Data: map[string]string{"id": c.TaskID}})
			}
		}
	}
}

func (s *Server) handleInteractionChanges(changes []state.InteractionChange) {
	for _, c := range changes {
		interactionID := c.InteractionID
		in, err := s.interactions.Get(interactionID)
		if err != nil {
			s.hub.Broadcast(Event{Type: "interaction.updated", Data: map[string]string{"id": interactionID}})
			continue
		}

		eventType := "interaction.updated"
		switch in.Status {
		case "running":
			eventType = "interaction.started"
		case "completed":
			eventType = "interaction.completed"
		case "failed":
			eventType = "interaction.failed"
		}
		s.hub.Broadcast(Event{Type: eventType, Data: in})
	}
}

func (s *Server) handleSessionChanges(changes []state.SessionChange) {
	for _, c := range changes {
		row := s.db.QueryRow(
			`SELECT id, type, tool, task_id, status, exit_code FROM sessions WHERE id = ?`,
			c.SessionID,
		)
		var (
			id       string
			typ      string
			toolName string
			taskID   sql.NullString
			status   string
			exitCode int
		)
		if err := row.Scan(&id, &typ, &toolName, &taskID, &status, &exitCode); err != nil {
			continue
		}
		taskIDValue := ""
		if taskID.Valid {
			taskIDValue = taskID.String
		}

		switch c.Type {
		case state.ChangeCreated:
			s.hub.Broadcast(Event{
				Type: "session.created",
				Data: map[string]interface{}{
					"id":        id,
					"type":      typ,
					"tool":      toolName,
					"task_id":   taskIDValue,
					"status":    status,
					"exit_code": exitCode,
				},
			})
		case state.ChangeUpdated:
			if status == "exited" {
				s.hub.Broadcast(Event{
					Type: "session.exited",
					Data: map[string]interface{}{
						"id":        id,
						"type":      typ,
						"tool":      toolName,
						"task_id":   taskIDValue,
						"status":    status,
						"exit_code": exitCode,
					},
				})
			}
		}
	}
}
