package mcp

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/toolcfg"
)

func (s *Server) HandleInteractionsListTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
		Phase  string `json:"phase"`
		Status string `json:"status"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("interactions_list: %w", err)
	}
	taskID := strings.TrimSpace(args.TaskID)
	if taskID == "" {
		return nil, fmt.Errorf("task_id is required")
	}
	if s.db == nil {
		return nil, fmt.Errorf("database not configured")
	}

	phase := strings.ToLower(strings.TrimSpace(args.Phase))
	status := strings.ToLower(strings.TrimSpace(args.Status))

	store := interaction.NewStore(s.db, ".orca/interactions")
	items, err := store.List(taskID)
	if err != nil {
		return nil, err
	}

	filtered := make([]interaction.Interaction, 0, len(items))
	for _, in := range items {
		if phase != "" && strings.ToLower(in.Phase) != phase {
			continue
		}
		if status != "" && strings.ToLower(in.Status) != status {
			continue
		}
		filtered = append(filtered, in)
	}

	return map[string]interface{}{
		"interactions": filtered,
	}, nil
}

func (s *Server) HandleInteractionGetTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		InteractionID string `json:"interaction_id"`
		Raw           bool   `json:"raw"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("interaction_get: %w", err)
	}
	interactionID := strings.TrimSpace(args.InteractionID)
	if interactionID == "" {
		return nil, fmt.Errorf("interaction_id is required")
	}
	if s.db == nil {
		return nil, fmt.Errorf("database not configured")
	}

	store := interaction.NewStore(s.db, ".orca/interactions")
	in, err := store.Get(interactionID)
	if err != nil {
		return nil, err
	}
	rawLog, err := store.ReadLog(interactionID)
	if err != nil {
		return nil, err
	}

	content := rawLog
	if !args.Raw {
		content = toolcfg.FormatLog(in.Tool, rawLog)
	}

	return map[string]interface{}{
		"id":             in.ID,
		"phase":          in.Phase,
		"attempt":        in.Attempt,
		"tool":           in.Tool,
		"status":         in.Status,
		"input_tokens":   in.InputTokens,
		"output_tokens":  in.OutputTokens,
		"estimated_cost": in.EstimatedCost,
		"duration_ms":    in.DurationMS,
		"content":        content,
	}, nil
}
