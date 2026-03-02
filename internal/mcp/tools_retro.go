package mcp

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/retro"
	"github.com/jasjeetmavi/orca/internal/task"
)

func (s *Server) HandleTasksRetroTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
		Tool   string `json:"tool"`
		Model  string `json:"model"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_retro: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}

	taskID, err := s.taskStore.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}
	t, err := s.taskStore.Get(taskID)
	if err != nil {
		return nil, err
	}
	if t.Status != "approved" && t.Status != "merged" {
		return nil, fmt.Errorf("task must be approved or merged to run retro")
	}

	interactionStore := interaction.NewStore(s.db, ".orca/interactions")
	running, err := interactionStore.IsRunning(&taskID, interaction.PhaseRetro)
	if err != nil {
		return nil, err
	}
	if running {
		return nil, fmt.Errorf("retro already in progress")
	}

	if past, listErr := interactionStore.ListByPhase(taskID, interaction.PhaseRetro); listErr == nil {
		for _, ix := range past {
			if ix.Status == "completed" {
				return nil, fmt.Errorf("retro already completed for this task")
			}
		}
	}

	toolName, d, err := s.config.ResolveToolForPhase(interaction.PhaseRetro, strings.TrimSpace(args.Tool))
	if err != nil {
		return nil, err
	}
	model := s.config.ResolveModelForPhase(interaction.PhaseRetro, strings.TrimSpace(args.Model), d)

	generator := retro.New(
		toolName,
		d,
		model,
		10*time.Minute,
		s.repoDir,
		memory.NewStore(s.db),
		task.NewStore(s.db),
		interactionStore,
	)
	result, err := generator.Run(taskID)
	if err != nil {
		return nil, fmt.Errorf("retro: %w", err)
	}

	return map[string]interface{}{
		"task_id": taskID,
		"retro":   result,
	}, nil
}
