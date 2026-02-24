package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/ops"
	"github.com/jasjeetmavi/orca/internal/task"
)

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

// runAsync launches a goroutine with panic recovery.
// On panic: logs, marks op as failed via ops.Fail, and broadcasts a
// "{eventPrefix}.failed" event with the error and any extraData fields.
func (s *Server) runAsync(opID, eventPrefix string, extraData map[string]interface{}, fn func()) {
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("%s panic: %v", eventPrefix, rec)
				if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
					slog.Error("mark operation failed", "operation_id", opID, "err", opErr)
				}
				data := map[string]interface{}{"error": errMsg}
				for k, v := range extraData {
					data[k] = v
				}
				s.hub.Broadcast(Event{Type: eventPrefix + ".failed", Data: data})
			}
		}()
		fn()
	}()
}

func (s *Server) startAsyncOp(w http.ResponseWriter, opType, targetID, eventPrefix string, extraData map[string]interface{}, responseData interface{}, fn func()) string {
	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     opType,
		TargetID: targetID,
		Status:   "running",
	}); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return ""
	}
	if extraData != nil {
		if _, ok := extraData["operation_id"]; ok {
			extraData["operation_id"] = opID
		}
	}
	switch data := responseData.(type) {
	case map[string]interface{}:
		if _, ok := data["operation_id"]; ok {
			data["operation_id"] = opID
		}
	case map[string]string:
		if _, ok := data["operation_id"]; ok {
			data["operation_id"] = opID
		}
	}
	jsonResponse(w, http.StatusAccepted, map[string]interface{}{"data": responseData})
	s.runAsync(opID, eventPrefix, extraData, fn)
	return opID
}
