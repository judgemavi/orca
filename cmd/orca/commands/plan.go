package commands

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/breakdown"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func RegisterPlan(root *cobra.Command, r *Registry) {
	planCmd := &cobra.Command{
		Use:   "breakdown [goal]",
		Short: "Break down a goal into tasks using an LLM",
		Args: func(cmd *cobra.Command, args []string) error {
			taskID, _ := cmd.Flags().GetString("task")
			hasTask := strings.TrimSpace(taskID) != ""
			hasGoal := len(args) > 0
			if hasTask && hasGoal {
				return fmt.Errorf("provide either a goal or --task, not both")
			}
			if !hasTask && !hasGoal {
				return fmt.Errorf("accepts 1 arg(s), received 0")
			}
			return nil
		},
		RunE: r.runPlan,
	}
	planCmd.Flags().String("tool", "", "Tool to use for breakdown")
	planCmd.Flags().Bool("auto", false, "Skip confirmation and create tasks immediately")
	planCmd.Flags().String("task", "", "Break down an existing task by ID (uses title+description as goal)")
	root.AddCommand(planCmd)
}

func (r *Registry) runPlan(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	goal := strings.Join(args, " ")
	store := task.NewStore(db)
	toolName, _ := cmd.Flags().GetString("tool")
	auto, _ := cmd.Flags().GetBool("auto")
	taskArg, _ := cmd.Flags().GetString("task")
	taskArg = strings.TrimSpace(taskArg)

	var parentTaskID *string
	var parentTaskTitle string
	if taskArg != "" {
		taskID, err := store.ResolveID(taskArg)
		if err != nil {
			return err
		}
		parentTask, err := store.Get(taskID)
		if err != nil {
			return err
		}
		goal = parentTask.Title + "\n\n" + parentTask.Description
		parentTaskID = &taskID
		parentTaskTitle = parentTask.Title
	}

	selectedTool, selectedToolDef, err := cfg.ResolveToolForPhase(interaction.PhasePlan, toolName)
	if err != nil {
		return err
	}
	model := cfg.ResolveModelForPhase(interaction.PhasePlan, "", selectedTool)

	repoDir, _ := os.Getwd()
	breaker := breakdown.New(selectedTool, selectedToolDef, model, 10*time.Minute, repoDir, interaction.NewStore(db, ".orca/interactions")).
		WithMemory(memory.NewStore(db)).
		WithTaskStore(store).
		WithSyncer(newConfiguredMemorySyncer(cfg, memory.NewStore(db), db, repoDir))

	fmt.Printf("Breaking down: %s\n\n", goal)
	tasks, _, err := breaker.Run(parentTaskID, goal)
	if err != nil {
		return fmt.Errorf("breakdown: %w", err)
	}

	fmt.Printf("Proposed %d tasks:\n\n", len(tasks))
	for i, t := range tasks {
		deps := ""
		if len(t.DependsOnIndices) > 0 {
			depStrs := make([]string, len(t.DependsOnIndices))
			for j, idx := range t.DependsOnIndices {
				depStrs[j] = fmt.Sprintf("#%d", idx+1)
			}
			deps = fmt.Sprintf("  [depends on %s]", strings.Join(depStrs, ", "))
		}
		tool := ""
		if t.SuggestedTool != "" {
			tool = fmt.Sprintf("  [tool: %s]", t.SuggestedTool)
		}
		fmt.Printf("  %d. %s%s%s\n", i+1, t.Title, deps, tool)
		if t.Description != "" {
			fmt.Printf("     %s\n", t.Description)
		}
	}

	if !auto {
		confirm := false
		if err := huh.NewConfirm().Title("Create these tasks?").Value(&confirm).Run(); err != nil {
			return err
		}
		if !confirm {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	createdIDs := make([]string, len(tasks))
	parentID := ""
	if parentTaskID != nil {
		parentID = *parentTaskID
	}
	for i, t := range tasks {
		created, err := store.Create(t.Title, t.Description, parentID)
		if err != nil {
			return fmt.Errorf("create task %d: %w", i+1, err)
		}
		createdIDs[i] = created.ID
	}

	for i, t := range tasks {
		for _, depIdx := range t.DependsOnIndices {
			if depIdx >= 0 && depIdx < len(createdIDs) {
				if err := store.AddDependency(createdIDs[i], createdIDs[depIdx]); err != nil {
					return fmt.Errorf("add dep for task %d: %w", i+1, err)
				}
			}
		}
	}

	if parentTaskID != nil {
		if err := store.Update(*parentTaskID, task.UpdateFields{Status: task.Ptr("broken_down")}); err != nil {
			return fmt.Errorf("update parent task status: %w", err)
		}
		fmt.Printf("\nParent task: %s (%s)\n", *parentTaskID, parentTaskTitle)
		fmt.Printf("Created %d child tasks.\n", len(tasks))
		return nil
	}

	fmt.Printf("\nCreated %d tasks.\n", len(tasks))
	return nil
}
