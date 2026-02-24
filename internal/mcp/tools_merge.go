package mcp

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/interaction"
)

func (s *Server) HandleMergeTool(_ json.RawMessage) (interface{}, error) {
	approved, err := s.taskStore.ListByStatus("approved")
	if err != nil {
		return nil, err
	}
	taskIDs := make([]string, 0, len(approved))
	for _, t := range approved {
		taskIDs = append(taskIDs, t.ID)
	}
	if len(taskIDs) == 0 {
		return nil, fmt.Errorf("no approved tasks to merge")
	}

	ig := integrator.New(s.repoDir, s.config.Project.IntegrationBranch, s.config.Validation.Commands, interaction.NewStore(s.db, ".orca/interactions"))
	merged, failed, err := ig.MergeBatch(taskIDs)
	if err != nil {
		return nil, err
	}

	for _, id := range merged {
		if err := s.taskStore.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
			return nil, fmt.Errorf("mark merged for %s: %w", id, err)
		}
		if err := s.executor.Worktrees().Remove(id); err != nil {
		}
	}

	return map[string]interface{}{
		"merged": merged,
		"failed": failed,
	}, nil
}

func (s *Server) HandleTasksMergeTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_merge: %w", err)
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
	if t.Status != "approved" {
		return nil, fmt.Errorf("task %s is %q, only approved tasks can be merged", taskID, t.Status)
	}

	ig := integrator.New(s.repoDir, s.config.Project.IntegrationBranch, s.config.Validation.Commands, interaction.NewStore(s.db, ".orca/interactions"))
	if err := ig.MergeAndValidate(taskID); err != nil {
		return nil, fmt.Errorf("merge task %s: %w", taskID, err)
	}
	if err := s.taskStore.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
		return nil, err
	}
	_ = s.executor.Worktrees().Remove(taskID)
	return map[string]interface{}{"task_id": taskID, "status": "merged"}, nil
}
