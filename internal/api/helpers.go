package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
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
		jsonError(w, "invalid JSON", 400)
		return v, false
	}
	return v, true
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
