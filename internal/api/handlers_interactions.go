package api

import (
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
)

func (s *Server) handleListInteractions(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("id")
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	phase := strings.TrimSpace(r.URL.Query().Get("phase"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))

	interactions, err := s.interactions.List(taskID)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	filtered := make([]interaction.Interaction, 0, len(interactions))
	for _, in := range interactions {
		if phase != "" && in.Phase != phase {
			continue
		}
		if status != "" && in.Status != status {
			continue
		}
		filtered = append(filtered, in)
	}

	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].StartedAt.Before(filtered[j].StartedAt)
	})

	jsonOK(w, map[string]interface{}{"interactions": filtered})
}

func (s *Server) handleGetInteraction(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("id")
	logID := r.PathValue("interactionID")
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	in, err := s.interactions.Get(logID)
	if err != nil || in.TaskID == nil || *in.TaskID != taskID {
		jsonError(w, "interaction not found", http.StatusNotFound)
		return
	}

	content, err := s.interactions.ReadLog(logID)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	formatted := driver.FormatLog(in.Tool, content)

	jsonOK(w, map[string]interface{}{
		"id":             in.ID,
		"task_id":        taskID,
		"phase":          in.Phase,
		"attempt":        in.Attempt,
		"tool":           in.Tool,
		"status":         in.Status,
		"diff":           in.Diff,
		"exit_code":      in.ExitCode,
		"duration_ms":    in.DurationMS,
		"input_tokens":   in.InputTokens,
		"output_tokens":  in.OutputTokens,
		"estimated_cost": in.EstimatedCost,
		"started_at":     in.StartedAt,
		"finished_at":    in.FinishedAt,
		"content":        formatted,
		"raw_content":    content,
	})
}

func (s *Server) handleStreamInteraction(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("id")
	logID := r.PathValue("interactionID")
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	in, err := s.interactions.Get(logID)
	if err != nil || in.TaskID == nil || *in.TaskID != taskID {
		jsonError(w, "interaction not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	sendData := func(payload string) error {
		lines := strings.Split(payload, "\n")
		for _, line := range lines {
			if _, err := fmt.Fprintf(w, "data: %s\n", line); err != nil {
				return err
			}
		}
		_, err := fmt.Fprint(w, "\n")
		return err
	}
	sendDone := func() error {
		_, err := fmt.Fprint(w, "event: done\ndata: {}\n\n")
		return err
	}

	if in.Status == "completed" || in.Status == "failed" {
		content, err := s.interactions.ReadLog(logID)
		if err == nil && content != "" {
			if err := sendData(driver.FormatLog(in.Tool, content)); err != nil {
				return
			}
		}
		_ = sendDone()
		flusher.Flush()
		return
	}

	offset := int64(0)
	pendingLine := ""
	drv, _ := driver.Get(in.Tool)
	for {
		select {
		case <-r.Context().Done():
			return
		default:
		}

		delta, nextOffset, err := readInteractionDelta(in.LogPath, offset)
		if err != nil {
			return
		}
		offset = nextOffset
		if delta != "" {
			formattedDelta := formatInteractionDelta(drv, delta, &pendingLine)
			if formattedDelta != "" {
				if err := sendData(formattedDelta); err != nil {
					return
				}
				flusher.Flush()
			}
		}

		current, err := s.interactions.Get(logID)
		if err != nil {
			return
		}
		if current.Status == "completed" || current.Status == "failed" {
			finalDelta, _, err := readInteractionDelta(current.LogPath, offset)
			if err == nil && finalDelta != "" {
				if drv == nil {
					drv, _ = driver.Get(current.Tool)
				}
				formattedFinal := formatInteractionDelta(drv, finalDelta, &pendingLine)
				if formattedFinal != "" {
					if err := sendData(formattedFinal); err != nil {
						return
					}
				}
			}
			if pendingLine != "" {
				if drv == nil {
					if err := sendData(pendingLine); err != nil {
						return
					}
				} else if tail := drv.FormatEvent([]byte(pendingLine)); tail != "" {
					if err := sendData(tail); err != nil {
						return
					}
				}
				pendingLine = ""
			}
			if err := sendDone(); err != nil {
				return
			}
			flusher.Flush()
			return
		}

		time.Sleep(500 * time.Millisecond)
	}
}

func formatInteractionDelta(d driver.Driver, chunk string, pendingLine *string) string {
	if pendingLine == nil {
		return ""
	}
	buffer := *pendingLine + chunk
	lastNewline := strings.LastIndexByte(buffer, '\n')
	if lastNewline < 0 {
		*pendingLine = buffer
		return ""
	}

	complete := buffer[:lastNewline+1]
	*pendingLine = buffer[lastNewline+1:]

	var out strings.Builder
	for _, line := range strings.Split(complete, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		formatted := line
		if d != nil {
			formatted = d.FormatEvent([]byte(line))
		}
		if formatted == "" {
			continue
		}
		out.WriteString(formatted)
	}
	return out.String()
}

func readInteractionDelta(path string, offset int64) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", offset, err
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return "", offset, err
	}
	if offset > stat.Size() {
		offset = stat.Size()
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return "", offset, err
	}

	b, err := io.ReadAll(f)
	if err != nil {
		return "", offset, err
	}
	return string(b), offset + int64(len(b)), nil
}

func (s *Server) handleListRunningInteractions(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	rows, err := s.db.Query(
		`SELECT id, task_id, phase, status, started_at
		 FROM task_interactions
		 WHERE status = 'running'
		 ORDER BY started_at ASC`,
	)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	operations := make([]map[string]interface{}, 0)
	for rows.Next() {
		var (
			id        string
			taskID    sql.NullString
			phase     string
			status    string
			startedAt time.Time
		)
		if err := rows.Scan(&id, &taskID, &phase, &status, &startedAt); err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return
		}

		taskValue := interface{}(nil)
		if taskID.Valid {
			taskValue = taskID.String
		}
		operations = append(operations, map[string]interface{}{
			"id":         id,
			"task_id":    taskValue,
			"phase":      phase,
			"status":     status,
			"started_at": startedAt,
		})
	}
	if err := rows.Err(); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{"operations": operations})
}
