package api

import (
	"net/http"

	"github.com/jasjeetmavi/orca/internal/executor"
)

// POST /api/v1/tasks/run
func (s *Server) handleRunTasks(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	req, ok := decodeJSON[struct {
		TaskIDs []string `json:"task_ids"`
		Tool    string   `json:"tool"`
		Model   string   `json:"model"`
	}](w, r, true)
	if !ok {
		return
	}

	if len(req.TaskIDs) == 0 {
		ready, err := s.taskStore.GetReady()
		if err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return
		}
		if len(ready) == 0 {
			jsonError(w, "no ready tasks", http.StatusBadRequest)
			return
		}
		maxParallel := s.cfg.Workers.MaxParallel
		if maxParallel <= 0 {
			maxParallel = 1
		}
		if len(ready) > maxParallel {
			ready = ready[:maxParallel]
		}
		for _, t := range ready {
			req.TaskIDs = append(req.TaskIDs, t.ID)
		}
	}

	s.runAsyncHandler(w, "run", map[string]interface{}{
		"task_ids": req.TaskIDs,
		"tool":     req.Tool,
		"model":    req.Model,
	}, func() {
		results, err := s.executor.RunBatch(req.TaskIDs, executor.RunOpts{
			ToolOverride:  req.Tool,
			ModelOverride: req.Model,
		})
		if err != nil {
			s.hub.Broadcast(Event{Type: "run.failed", Data: map[string]interface{}{
				"error":    err.Error(),
				"task_ids": req.TaskIDs,
			}})
			return
		}

		s.hub.Broadcast(Event{Type: "run.completed", Data: map[string]interface{}{
			"results":  results,
			"task_ids": req.TaskIDs,
		}})
	})
}
