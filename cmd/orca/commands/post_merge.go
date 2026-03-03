package commands

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/retro"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
)

type postMergeFailure struct {
	Operation string `json:"operation"`
	TaskID    string `json:"task_id,omitempty"`
	Error     string `json:"error"`
}

func runPostMergeRetro(cfg *config.Config, db *state.DB, repoDir, taskID string) error {
	if cfg == nil || db == nil {
		return fmt.Errorf("retro not configured")
	}
	if strings.TrimSpace(taskID) == "" {
		return fmt.Errorf("task id required")
	}

	interactions := interaction.NewStore(db, ".orca/interactions")
	if past, err := interactions.ListByPhase(taskID, interaction.PhaseRetro); err == nil {
		for _, in := range past {
			if in.Status == "completed" {
				return nil
			}
		}
	}

	toolName, tool, err := cfg.ResolveToolForPhase(interaction.PhaseRetro, "")
	if err != nil {
		return nil
	}
	model := cfg.ResolveModelForPhase(interaction.PhaseRetro, "", toolName)

	generator := retro.New(
		toolName,
		tool,
		model,
		10*time.Minute,
		repoDir,
		memory.NewStore(db),
		task.NewStore(db),
		interactions,
	)
	_, err = generator.Run(taskID)
	return err
}

func runPostMergeSync(cfg *config.Config, db *state.DB, repoDir string) (*memory.SyncResult, error) {
	if db == nil {
		return nil, fmt.Errorf("sync not configured")
	}
	store := memory.NewStore(db)
	syncer := newConfiguredMemorySyncer(cfg, store, db, repoDir)
	return syncer.Sync()
}

func recordPostMergeFailure(interactions *interaction.Store, taskID, operation string, err error) {
	if interactions == nil || err == nil {
		return
	}
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
