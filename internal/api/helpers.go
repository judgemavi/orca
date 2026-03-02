package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/jasjeetmavi/orca/internal/task"
)

type taskHandlerFunc func(w http.ResponseWriter, r *http.Request, tk *task.Task)

// decodeJSON decodes the request body into T.
// Returns the decoded value and true on success.
// On failure, writes a 400 JSON error and returns zero, false.
// If allowEmpty is true, an empty body (io.EOF) is not an error.
func decodeJSON[T any](w http.ResponseWriter, r *http.Request, allowEmpty bool) (T, bool) {
	var v T
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
		if allowEmpty && err == io.EOF {
			return v, true
		}
		jsonError(w, "invalid JSON", http.StatusBadRequest)
		return v, false
	}
	return v, true
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method != method {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func resolveTaskID(w http.ResponseWriter, store *task.Store, id string) (string, bool) {
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return "", false
	}
	return resolved, true
}

func (s *Server) withTask(fn taskHandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resolved, ok := resolveTaskID(w, s.taskStore, r.PathValue("id"))
		if !ok {
			return
		}

		tk, err := s.taskStore.Get(resolved)
		if err != nil {
			jsonError(w, err, http.StatusNotFound)
			return
		}

		fn(w, r, tk)
	}
}

func (s *Server) withTaskValidation(validationErr string, allowedStatuses []string, fn taskHandlerFunc) http.HandlerFunc {
	allowed := make(map[string]struct{}, len(allowedStatuses))
	for _, status := range allowedStatuses {
		allowed[status] = struct{}{}
	}

	return s.withTask(func(w http.ResponseWriter, r *http.Request, tk *task.Task) {
		if _, ok := allowed[tk.Status]; !ok {
			jsonError(w, validationErr, http.StatusBadRequest)
			return
		}
		fn(w, r, tk)
	})
}

func (s *Server) runAsyncHandler(w http.ResponseWriter, eventPrefix string, responseData interface{}, fn func()) {
	jsonResponse(w, http.StatusAccepted, map[string]interface{}{"data": responseData})
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("async handler panic", "prefix", eventPrefix, "panic", rec)
				s.hub.Broadcast(Event{
					Type: eventPrefix + ".failed",
					Data: map[string]string{"error": fmt.Sprintf("%v", rec)},
				})
			}
		}()
		fn()
	}()
}
