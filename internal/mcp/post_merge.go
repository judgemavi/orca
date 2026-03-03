package mcp

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
	if strings.TrimSpace(taskID) == "" || s.db == nil || s.config == nil {
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

	toolName, tool, err := s.config.ResolveToolForPhase(interaction.PhaseRetro, "")
	if err != nil {
		return nil
	}
	model := s.config.ResolveModelForPhase(interaction.PhaseRetro, "", toolName)

	generator := retro.New(
		toolName,
		tool,
		model,
		10*time.Minute,
		s.repoDir,
		memory.NewStore(s.db),
		task.NewStore(s.db),
		interactions,
	)
	_, runErr := generator.Run(taskID)
	if runErr != nil {
		s.recordPostMergeFailure(taskID, "retro", runErr)
	}
	return runErr
}

func (s *Server) runPostMergeSync(taskIDs []string) (*memory.SyncResult, error) {
	syncer := s.newMemorySyncer(s.memoryStore)
	result, err := syncer.Sync()
	if err != nil {
		for _, taskID := range taskIDs {
			s.recordPostMergeFailure(taskID, "sync", err)
		}
		return nil, err
	}
	return result, nil
}

func (s *Server) recordPostMergeFailure(taskID, operation string, err error) {
	if s.db == nil || err == nil {
		return
	}
	interactions := interaction.NewStore(s.db, ".orca/interactions")
	id := strings.TrimSpace(taskID)
	var taskRef *string
	if id != "" {
		taskRef = &id
	}
	writer, beginErr := interactions.Begin(taskRef, interaction.PhaseMerge, "orca")
	if beginErr != nil {
		return
	}
	defer writer.Close()

	payload, _ := json.Marshal(postMergeFailure{
		Operation: strings.TrimSpace(operation),
		TaskID:    id,
		Error:     err.Error(),
	})
	_ = interactions.Finish(
		writer.ID(),
		"failed",
		interaction.WithError(err.Error()),
		interaction.WithQuality(string(payload)),
	)
}
