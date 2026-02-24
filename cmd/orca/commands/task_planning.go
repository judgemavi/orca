package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/evaluate"
	"github.com/jasjeetmavi/orca/internal/ops"
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

	toolName, toolCfg, err := cfg.ResolveToolForPhase(t, "plan", toolOverride)
	if err != nil {
		return err
	}

	modelName := config.ValidateModel(toolName, modelOverride, toolCfg)
	if modelName == "" {
		modelName = toolCfg.Model
	}

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	generator := planpkg.New(toolCfg, repoDir)
	var planContent string
	if err := ops.WithOperation(db, "plan_generate", id, func() error {
		fmt.Printf("Generating plan for task %s\n", short(id))
		spinDone := make(chan struct{})
		go renderSpinner("Generating plan", spinDone)
		if modelName != "" {
			planContent, err = generator.GenerateWithModel(t.Title, t.Description, modelName)
		} else {
			planContent, err = generator.Generate(t.Title, t.Description)
		}
		close(spinDone)
		fmt.Print("\r")
		if err != nil {
			return fmt.Errorf("generate plan: %w", err)
		}
		return nil
	}); err != nil {
		return err
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

	toolName, toolCfg, err := cfg.ResolveToolForPhase(t, "explore", toolOverride)
	if err != nil {
		return err
	}

	modelName := config.ValidateModel(toolName, modelOverride, toolCfg)
	if modelName == "" {
		modelName = toolCfg.Model
	}

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	evaluator := evaluate.New(toolCfg, repoDir)
	var result *evaluate.EvaluationResult
	if err := ops.WithOperation(db, "plan_evaluate", id, func() error {
		fmt.Println("Evaluating task complexity...")
		done := make(chan struct{})
		go renderSpinner("Evaluating task complexity", done)

		if modelName != "" {
			result, err = evaluator.EvaluateWithModel(t.Title, t.Description, modelName)
		} else {
			result, err = evaluator.Evaluate(t.Title, t.Description)
		}
		close(done)
		fmt.Print("\r")
		if err != nil {
			return fmt.Errorf("evaluate task: %w", err)
		}
		return nil
	}); err != nil {
		return err
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
