package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/evaluate"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	planpkg "github.com/jasjeetmavi/orca/internal/plan"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func (r *Registry) runTaskPlan(cmd *cobra.Command, args []string) error {
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
		id, err = pickTask(store, "Task", statusFilter())
	}
	if err != nil {
		return err
	}
	t, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}

	save, _ := cmd.Flags().GetBool("save")
	edit, _ := cmd.Flags().GetBool("edit")
	toolOverride, _ := cmd.Flags().GetString("tool")
	modelOverride, _ := cmd.Flags().GetString("model")

	toolName, d, err := cfg.ResolveToolForPhase(interaction.PhasePlan, toolOverride)
	if err != nil {
		return err
	}
	modelName := cfg.ResolveModelForPhase(interaction.PhasePlan, modelOverride, d)

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	generator := planpkg.New(toolName, d, modelName, 10*time.Minute, repoDir, interaction.NewStore(db, ".orca/interactions")).
		WithMemory(memory.NewStore(db))
	var planContent string
	fmt.Printf("Generating plan for task %s\n", short(id))
	spinDone := make(chan struct{})
	go renderSpinner("Generating plan", spinDone)
	if modelName != "" {
		planContent, err = generator.GenerateWithModel(id, t.Title, t.Description, modelName)
	} else {
		planContent, err = generator.Generate(id, t.Title, t.Description)
	}
	close(spinDone)
	fmt.Print("\r")
	if err != nil {
		return fmt.Errorf("generate plan: %w", err)
	}

	fmt.Println(planContent)

	shouldSave := save || edit
	if shouldSave {
		if err := store.SetPlan(id, planContent); err != nil {
			return fmt.Errorf("save plan: %w", err)
		}
		if save && !edit {
			fmt.Printf("\nSaved plan to task %s\n", short(id))
		}
	}
	if !edit {
		return nil
	}

	editor := strings.TrimSpace(os.Getenv("EDITOR"))
	if editor == "" {
		return fmt.Errorf("EDITOR is not set")
	}

	tmpFile, err := os.CreateTemp("", "orca-plan-*.md")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	if _, err := tmpFile.WriteString(planContent); err != nil {
		tmpFile.Close()
		return fmt.Errorf("write temp plan: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return fmt.Errorf("close temp plan: %w", err)
	}
	defer os.Remove(tmpPath)

	editCmd := exec.Command("sh", "-c", fmt.Sprintf("%s %q", editor, tmpPath))
	editCmd.Stdin = os.Stdin
	editCmd.Stdout = os.Stdout
	editCmd.Stderr = os.Stderr
	if err := editCmd.Run(); err != nil {
		return fmt.Errorf("open editor: %w", err)
	}

	edited, err := os.ReadFile(tmpPath)
	if err != nil {
		return fmt.Errorf("read edited plan: %w", err)
	}
	if err := store.SetPlan(id, strings.TrimSpace(string(edited))); err != nil {
		return fmt.Errorf("save edited plan: %w", err)
	}

	fmt.Printf("\nSaved edited plan to task %s\n", short(id))
	return nil
}

func (r *Registry) runTaskEvaluate(cmd *cobra.Command, args []string) error {
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
		id, err = pickTask(store, "Task", statusFilter())
	}
	if err != nil {
		return err
	}

	t, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}

	toolOverride, _ := cmd.Flags().GetString("tool")
	modelOverride, _ := cmd.Flags().GetString("model")
	jsonOutput, _ := cmd.Flags().GetBool("json")

	toolName, d, err := cfg.ResolveToolForPhase(interaction.PhaseExplore, toolOverride)
	if err != nil {
		return err
	}
	modelName := cfg.ResolveModelForPhase(interaction.PhaseExplore, modelOverride, d)

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	evaluator := evaluate.New(toolName, d, modelName, 10*time.Minute, repoDir, interaction.NewStore(db, ".orca/interactions"))
	var result *evaluate.EvaluationResult
	fmt.Println("Evaluating task complexity...")
	done := make(chan struct{})
	go renderSpinner("Evaluating task complexity", done)

	if modelName != "" {
		result, err = evaluator.EvaluateWithModel(id, t.Title, t.Description, modelName)
	} else {
		result, err = evaluator.Evaluate(id, t.Title, t.Description)
	}
	close(done)
	fmt.Print("\r")
	if err != nil {
		return fmt.Errorf("evaluate task: %w", err)
	}

	if jsonOutput {
		data, err := json.Marshal(result)
		if err != nil {
			return fmt.Errorf("marshal evaluation result: %w", err)
		}
		fmt.Println(string(data))
		return nil
	}

	needsBreakdown := "no"
	if result.NeedsBreakdown {
		needsBreakdown = "yes"
	}
	fmt.Printf("Needs breakdown: %s\n", needsBreakdown)
	fmt.Printf("Confidence: %.2f\n", result.Confidence)
	fmt.Printf("Reasoning: %s\n", result.Reasoning)
	fmt.Printf("Suggested subtasks: %d\n", result.SuggestedSubtaskCount)
	return nil
}

func (r *Registry) runTaskApprovePlan(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	var id string
	if len(args) > 0 {
		id, err = resolveTaskID(store, args[0])
	} else {
		id, err = pickTask(store, "Approve plan", statusFilter("pending"))
	}
	if err != nil {
		return err
	}

	tk, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task %s: %w", short(id), err)
	}
	if tk.Status != "pending" {
		return fmt.Errorf("task %s is %q, expected %q", short(id), tk.Status, "pending")
	}
	if strings.TrimSpace(tk.Plan) == "" {
		return fmt.Errorf("task %s must have a plan to approve", short(id))
	}

	if err := store.Update(id, map[string]interface{}{"status": "planned"}); err != nil {
		return fmt.Errorf("approve plan for task %s: %w", short(id), err)
	}

	fmt.Printf("Plan approved for task %s\n", short(id))
	return nil
}

func (r *Registry) runTaskRequestPlanChanges(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	store := task.NewStore(db)
	interactions := interaction.NewStore(db, ".orca/interactions")

	var (
		taskID   string
		feedback string
	)
	switch len(args) {
	case 0:
		taskID, err = pickTask(store, "Request plan changes", statusFilter("pending"))
		if err != nil {
			return err
		}
		if err := huh.NewText().Title("Feedback").Value(&feedback).Run(); err != nil {
			return err
		}
	case 1:
		taskID, err = resolveTaskID(store, args[0])
		if err != nil {
			return err
		}
		if err := huh.NewText().Title("Feedback").Value(&feedback).Run(); err != nil {
			return err
		}
	default:
		taskID, err = resolveTaskID(store, args[0])
		if err != nil {
			return err
		}
		feedback = args[1]
	}

	tk, err := store.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task %s: %w", short(taskID), err)
	}
	if tk.Status != "pending" {
		return fmt.Errorf("task %s is %q, expected %q", short(taskID), tk.Status, "pending")
	}
	if strings.TrimSpace(tk.Plan) == "" {
		return fmt.Errorf("task %s must have a plan before requesting changes", short(taskID))
	}

	feedback = strings.TrimSpace(feedback)
	if feedback == "" {
		return fmt.Errorf("feedback cannot be empty")
	}

	latestPlanInteractionID, err := latestCompletedPlanInteractionID(interactions, taskID)
	if err != nil {
		return err
	}

	running, err := interactions.IsRunning(&taskID, interaction.PhasePlan)
	if err != nil {
		return fmt.Errorf("check running plan generation: %w", err)
	}
	if running {
		return fmt.Errorf("plan generation already in progress")
	}

	toolOverride, _ := cmd.Flags().GetString("tool")
	modelOverride, _ := cmd.Flags().GetString("model")
	toolName, d, err := cfg.ResolveToolForPhase(interaction.PhasePlan, toolOverride)
	if err != nil {
		return err
	}
	modelName := cfg.ResolveModelForPhase(interaction.PhasePlan, modelOverride, d)

	reviewID, err := store.AddReview(taskID, feedback, latestPlanInteractionID)
	if err != nil {
		return fmt.Errorf("add plan review for task %s: %w", short(taskID), err)
	}

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}
	description := strings.TrimSpace(tk.Description + "\n\nPlan feedback to incorporate:\n" + feedback)
	generator := planpkg.New(toolName, d, modelName, 10*time.Minute, repoDir, interactions).
		WithMemory(memory.NewStore(db))

	fmt.Printf("Regenerating plan for task %s\n", short(taskID))
	spinDone := make(chan struct{})
	go renderSpinner("Regenerating plan", spinDone)
	var planContent string
	if modelName != "" {
		planContent, err = generator.GenerateWithModel(taskID, tk.Title, description, modelName)
	} else {
		planContent, err = generator.Generate(taskID, tk.Title, description)
	}
	close(spinDone)
	fmt.Print("\r")
	if err != nil {
		return fmt.Errorf("generate plan: %w", err)
	}

	if err := store.SetPlan(taskID, planContent); err != nil {
		return fmt.Errorf("save plan for task %s: %w", short(taskID), err)
	}
	if err := store.AddressReview(reviewID); err != nil {
		return fmt.Errorf("address plan review for task %s: %w", short(taskID), err)
	}

	fmt.Printf("Plan regenerated for task %s\n", short(taskID))
	return nil
}

func latestCompletedPlanInteractionID(interactions *interaction.Store, taskID string) (string, error) {
	items, err := interactions.ListByPhase(taskID, interaction.PhasePlan)
	if err != nil {
		return "", fmt.Errorf("list plan interactions for task %s: %w", short(taskID), err)
	}
	for _, in := range items {
		if in.Status == "completed" {
			return in.ID, nil
		}
	}
	return "", fmt.Errorf("task %s has no completed plan interaction", short(taskID))
}
