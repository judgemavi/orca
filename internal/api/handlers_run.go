package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

// POST /api/v1/tasks/run
func (s *Server) handleRunTasks(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	req, ok := decodeJSON[struct {
		TaskIDs []string `json:"task_ids"`
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

	opID := ""
	opID = s.startAsyncOp(
		w,
		"run",
		strings.Join(req.TaskIDs, ","),
		"run",
		map[string]interface{}{"operation_id": ""},
		map[string]interface{}{"operation_id": "", "task_ids": req.TaskIDs},
		func() {
			results, err := s.executor.RunBatch(req.TaskIDs)
			if err != nil {
				if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
					slog.Error("mark operation failed", "operation_id", opID, "err", opErr)
				}
				s.hub.Broadcast(Event{Type: "run.failed", Data: map[string]interface{}{
					"error":    err.Error(),
					"task_ids": req.TaskIDs,
				}})
				return
			}

			resultJSON, _ := json.Marshal(results)
			if err := s.ops.Complete(opID, string(resultJSON)); err != nil {
				slog.Error("mark operation completed", "operation_id", opID, "err", err)
			}
			s.hub.Broadcast(Event{Type: "run.completed", Data: map[string]interface{}{
				"results":  results,
				"task_ids": req.TaskIDs,
			}})
		},
	)
	if opID == "" {
		return
	}
}
