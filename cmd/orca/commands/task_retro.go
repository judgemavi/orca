package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/retro"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func (r *Registry) runTaskRetro(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	store := task.NewStore(db)
	defer db.Close()

	var id string
	if len(args) > 0 {
		id, err = resolveTaskID(store, args[0])
	} else {
		id, err = pickTask(store, "Task", statusFilter("approved", "merged"))
	}
	if err != nil {
		return err
	}

	tk, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}
	if tk.Status != "approved" && tk.Status != "merged" {
		return fmt.Errorf("task %s must be approved or merged (got %q)", short(id), tk.Status)
	}

	interactionStore := interaction.NewStore(db, ".orca/interactions")
	if past, listErr := interactionStore.ListByPhase(id, interaction.PhaseRetro); listErr == nil {
		for _, ix := range past {
			if ix.Status == "completed" {
				return fmt.Errorf("retro already completed for task %s", short(id))
			}
		}
	}

	toolOverride, _ := cmd.Flags().GetString("tool")
	modelOverride, _ := cmd.Flags().GetString("model")
	jsonOutput, _ := cmd.Flags().GetBool("json")

	toolName, d, err := cfg.ResolveToolForPhase(interaction.PhaseRetro, toolOverride)
	if err != nil {
		return err
	}
	modelName := cfg.ResolveModelForPhase(interaction.PhaseRetro, modelOverride, d)

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	retroGenerator := retro.New(
		toolName,
		d,
		modelName,
		10*time.Minute,
		repoDir,
		memory.NewStore(db),
		task.NewStore(db),
		interaction.NewStore(db, ".orca/interactions"),
	)

	fmt.Printf("Running retro for task %s\n", short(id))
	done := make(chan struct{})
	go renderSpinner("Generating retro", done)
	result, err := retroGenerator.Run(id)
	close(done)
	fmt.Print("\r")
	if err != nil {
		return fmt.Errorf("run retro: %w", err)
	}

	if jsonOutput {
		data, err := json.Marshal(result)
		if err != nil {
			return fmt.Errorf("marshal retro result: %w", err)
		}
		fmt.Println(string(data))
		return nil
	}

	fmt.Printf("Task: %s\n", short(result.TaskID))
	fmt.Printf("Provenance hash: %s\n", result.ProvenanceHash)
	fmt.Printf("Extracted: %d\n", result.ExtractedCount)
	fmt.Printf("Created: %d\n", result.CreatedCount)
	fmt.Printf("Skipped: %d\n", result.SkippedCount)
	fmt.Printf("Duplicate provenance: %t\n", result.DuplicateProvenance)
	if len(result.CreatedEntryIDs) > 0 {
		fmt.Printf("Created memory IDs: %v\n", result.CreatedEntryIDs)
	}

	return nil
}
