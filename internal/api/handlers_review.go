package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jasjeetmavi/orca/internal/review"
)

// ========== Sprint Review ==========

func (s *Server) handleGetReview(w http.ResponseWriter, r *http.Request, sprintID string) {
	sp, err := s.planner.Get(sprintID)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}

	type artifact struct {
		TaskID      string      `json:"task_id"`
		Title       string      `json:"title"`
		Status      string      `json:"status"`
		Diff        string      `json:"diff,omitempty"`
		Files       []string    `json:"files,omitempty"`
		DurationMs  int64       `json:"duration_ms"`
		QualityJSON string      `json:"quality_json,omitempty"`
		Quality     interface{} `json:"quality"`
	}

	var artifacts []artifact
	for _, taskID := range sp.TaskIDs {
		t, err := s.planner.GetTask(taskID)
		if err != nil {
			continue
		}

		a := artifact{TaskID: taskID, Title: t.Title, Status: t.Status}

		var diff, stdout, stderr string
		var qualityJSON sql.NullString
		var exitCode int
		var durationMs int64
		artErr := s.db.QueryRow(
			`SELECT diff, stdout, stderr, exit_code, duration_ms, quality_json FROM artifacts WHERE task_id = ? AND sprint_id = ? ORDER BY rowid DESC LIMIT 1`,
			taskID, sprintID,
		).Scan(&diff, &stdout, &stderr, &exitCode, &durationMs, &qualityJSON)

		if artErr == nil {
			a.Diff = diff
			a.DurationMs = durationMs
			if qualityJSON.Valid {
				raw := strings.TrimSpace(qualityJSON.String)
				if raw != "" {
					a.QualityJSON = raw
					var parsed interface{}
					if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
						a.Quality = parsed
					}
				}
			}
			for _, line := range strings.Split(diff, "\n") {
				if strings.HasPrefix(line, "+++ b/") {
					a.Files = append(a.Files, strings.TrimPrefix(line, "+++ b/"))
				}
			}
		}
		artifacts = append(artifacts, a)
	}

	jsonOK(w, map[string]interface{}{"sprint_id": sprintID, "artifacts": artifacts})
}

func (s *Server) handlePostReview(w http.ResponseWriter, r *http.Request, sprintID string) {
	type reviewReq struct {
		Auto bool `json:"auto"`
	}
	req, ok := decodeJSON[reviewReq](w, r, true)
	if !ok {
		return
	}

	if !req.Auto {
		jsonError(w, "set auto=true for automated review", http.StatusBadRequest)
		return
	}

	sp, err := s.planner.Get(sprintID)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}
	if _, err := s.ops.GetByTarget(sprintID, "review"); err == nil {
		jsonError(w, "review already in progress for sprint", http.StatusConflict)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	_, reviewToolCfg, err := s.cfg.ResolvePhaseToolConfig("review")
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	var inputs []review.ReviewInput
	for _, taskID := range sp.TaskIDs {
		t, err := s.planner.GetTask(taskID)
		if err != nil || t.Status != "approved" {
			continue
		}

		var diff string
		s.db.QueryRow(`SELECT diff FROM artifacts WHERE task_id = ? AND sprint_id = ?`, taskID, sprintID).Scan(&diff)
		if diff == "" {
			continue
		}

		inputs = append(inputs, review.ReviewInput{
			TaskID:      taskID,
			Title:       t.Title,
			Description: t.Description,
			Diff:        diff,
		})
	}

	opID := ""
	opID = s.startAsyncOp(
		w,
		"review",
		sprintID,
		"review",
		map[string]interface{}{"operation_id": ""},
		map[string]string{"operation_id": ""},
		func() {
			s.hub.Broadcast(Event{Type: "review.started", Data: map[string]interface{}{
				"operation_id": opID,
				"sprint_id":    sprintID,
			}})

			reviewer := review.New(reviewToolCfg, s.repoDir)
			results := make([]review.ReviewResult, 0, len(inputs))
			for _, in := range inputs {
				res, err := reviewer.Review(in.TaskID, in.Title, in.Description, in.Diff)
				if err != nil {
					results = append(results, review.ReviewResult{
						TaskID:   in.TaskID,
						Approved: false,
						Feedback: fmt.Sprintf("review error: %v", err),
						Tool:     reviewToolCfg.Binary,
					})
				} else {
					results = append(results, *res)
				}
				s.hub.Broadcast(Event{Type: "review.progress", Data: map[string]interface{}{
					"operation_id": opID,
					"task_id":      in.TaskID,
					"status":       "reviewed",
				}})
			}

			resultBytes, err := json.Marshal(map[string]interface{}{"results": results})
			if err != nil {
				errMsg := fmt.Sprintf("marshal review results: %v", err)
				if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
					slog.Error("mark review operation failed", "operation_id", opID, "err", opErr)
				}
				s.hub.Broadcast(Event{Type: "review.failed", Data: map[string]interface{}{
					"operation_id": opID,
					"error":        errMsg,
				}})
				return
			}
			if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
				slog.Debug("complete review operation failed", "operation_id", opID, "err", err)
			}

			s.hub.Broadcast(Event{Type: "review.completed", Data: map[string]interface{}{
				"operation_id": opID,
				"sprint_id":    sprintID,
				"results":      results,
			}})
		},
	)
	if opID == "" {
		return
	}
}
