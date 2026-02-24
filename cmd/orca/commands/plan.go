package commands

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/decompose"
	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func RegisterPlan(root *cobra.Command, r *Registry) {
	planCmd := &cobra.Command{Use: "breakdown [goal]", Short: "Break down a goal into tasks using an LLM", Args: cobra.MinimumNArgs(1), RunE: r.runPlan}
	planCmd.Flags().String("tool", "", "Tool to use for decomposition")
	planCmd.Flags().Bool("auto", false, "Skip confirmation and create tasks immediately")
	root.AddCommand(planCmd)
}

func (r *Registry) runPlan(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	goal := strings.Join(args, " ")
	toolName, _ := cmd.Flags().GetString("tool")
	auto, _ := cmd.Flags().GetBool("auto")

	var selectedTool string
	var selectedDriver driver.Driver
	if toolName != "" {
		name, drv, err := cfg.ResolveToolForPhase("plan", toolName)
		if err != nil {
			return err
		}
		selectedTool = name
		selectedDriver = drv
	} else {
		name, drv, err := cfg.ResolveToolForPhase("plan", "")
		if err != nil {
			return err
		}
		selectedTool = name
		selectedDriver = drv
	}
	model := cfg.ResolveModelForPhase("plan", "", selectedDriver)

	repoDir, _ := os.Getwd()
	store := task.NewStore(db)
	decomposer := decompose.New(selectedTool, selectedDriver, model, 10*time.Minute, repoDir, interaction.NewStore(db, ".orca/interactions"))

	fmt.Printf("Decomposing: %s\n\n", goal)
	tasks, _, err := decomposer.Run(nil, goal)
	if err != nil {
		return fmt.Errorf("decompose: %w", err)
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
	for i, t := range tasks {
		created, err := store.Create(t.Title, t.Description, "")
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

	fmt.Printf("\nCreated %d tasks.\n", len(tasks))
	return nil
}
