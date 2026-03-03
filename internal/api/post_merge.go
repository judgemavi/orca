package api

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/retro"
	"github.com/jasjeetmavi/orca/internal/task"
)

type postMergeFailure struct {
	Operation string `json:"operation"`
	TaskID    string `json:"task_id,omitempty"`
	Error     string `json:"error"`
}

func (s *Server) runPostMergeRetro(taskID string) error {
	if strings.TrimSpace(taskID) == "" || s.db == nil || s.cfg == nil {
		return nil
	}

	interactions := interaction.NewStore(s.db, ".orca/interactions")
	if past, err := interactions.ListByPhase(taskID, interaction.PhaseRetro); err == nil {
		for _, in := range past {
			if in.Status == "completed" {
				return nil
			}
		}
	}

	toolName, tool, err := s.cfg.ResolveToolForPhase(interaction.PhaseRetro, "")
	if err != nil {
		return nil
	}
	modelName := s.cfg.ResolveModelForPhase(interaction.PhaseRetro, "", toolName)

	generator := retro.New(
		toolName,
		tool,
		modelName,
		10*time.Minute,
		s.repoDir,
		memory.NewStore(s.db),
		task.NewStore(s.db),
		interactions,
	)
	result, runErr := generator.Run(taskID)
	if runErr != nil {
		s.recordPostMergeFailure(taskID, "retro", runErr)
		s.hub.Broadcast(Event{Type: "retro.failed", Data: map[string]string{"task_id": taskID, "error": runErr.Error()}})
		return runErr
	}

	s.hub.Broadcast(Event{Type: "retro.completed", Data: map[string]interface{}{"task_id": taskID, "retro": result}})
	return nil
}

func (s *Server) runPostMergeSync(taskIDs []string) (*memory.SyncResult, error) {
	if s.memoryStore == nil || s.db == nil {
		return nil, nil
	}

	syncer := s.newMemorySyncer(s.memoryStore)
	result, err := syncer.Sync()
	if err != nil {
		for _, taskID := range taskIDs {
			s.recordPostMergeFailure(taskID, "sync", err)
		}
		payload := map[string]string{"error": err.Error()}
		s.hub.Broadcast(Event{Type: "sync.failed", Data: payload})
		s.hub.Broadcast(Event{Type: "memory.sync.failed", Data: payload})
		return nil, err
	}

	s.hub.Broadcast(Event{Type: "sync.completed", Data: result})
	s.hub.Broadcast(Event{Type: "memory.sync.completed", Data: result})
	return result, nil
}

func (s *Server) recordPostMergeFailure(taskID, operation string, err error) {
	if s.interactions == nil || err == nil {
		return
	}

	id := strings.TrimSpace(taskID)
	var taskRef *string
	if id != "" {
		taskRef = &id
	}

	writer, beginErr := s.interactions.Begin(taskRef, interaction.PhaseMerge, "orca")
	if beginErr != nil {
		return
	}
	defer writer.Close()

	payload, _ := json.Marshal(postMergeFailure{
		Operation: strings.TrimSpace(operation),
		TaskID:    id,
		Error:     err.Error(),
	})
	_ = s.interactions.Finish(
		writer.ID(),
		"failed",
		interaction.WithError(err.Error()),
		interaction.WithQuality(string(payload)),
	)
}
