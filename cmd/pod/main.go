package main

import (
	"database/sql"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jasjeetmavi/pod/internal/autopilot"
	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/cost"
	"github.com/jasjeetmavi/pod/internal/decompose"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/integrator"
	"github.com/jasjeetmavi/pod/internal/review"
	"github.com/jasjeetmavi/pod/internal/sprint"
	"github.com/jasjeetmavi/pod/internal/state"
	"github.com/jasjeetmavi/pod/internal/task"
	"github.com/jasjeetmavi/pod/internal/tui"
	"github.com/jasjeetmavi/pod/internal/worktree"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// openStore opens the state DB and returns a task Store.
// Prints a user-friendly message and exits if Pod isn't initialized.
func openStore() (*state.DB, *task.Store) {
	dbPath := filepath.Join(".pod", "state.db")
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		fmt.Fprintln(os.Stderr, "Pod not initialized. Run 'pod init' first.")
		os.Exit(1)
	}
	db, err := state.Open(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open database: %v\n", err)
		os.Exit(1)
	}
	return db, task.NewStore(db)
}

// loadRuntime opens DB, loads config, and creates the sprint planner + executor.
func loadRuntime() (*state.DB, *config.Config, *sprint.Planner, *sprint.Executor, error) {
	dbPath := filepath.Join(".pod", "state.db")
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		return nil, nil, nil, nil, fmt.Errorf("pod not initialized — run 'pod init' first")
	}
	db, err := state.Open(dbPath)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("open database: %w", err)
	}

	cfg, err := config.Load(filepath.Join(".pod", "pod.yaml"))
	if err != nil {
		db.Close()
		return nil, nil, nil, nil, fmt.Errorf("load config: %w", err)
	}

	repoDir, err := os.Getwd()
	if err != nil {
		db.Close()
		return nil, nil, nil, nil, fmt.Errorf("get working directory: %w", err)
	}

	wm := worktree.NewManager(repoDir, cfg.Project.WorktreeDir)
	planner := sprint.NewPlanner(db)
	executor := sprint.NewExecutor(planner, wm, cfg, repoDir)
	executor.SetCostTracker(cost.NewTracker(db))

	return db, cfg, planner, executor, nil
}

func main() {
	root := &cobra.Command{
		Use:   "pod",
		Short: "Multi-agent CLI orchestrator",
	}

	// pod init
	root.AddCommand(&cobra.Command{
		Use:   "init",
		Short: "Initialize Pod in current git repo",
		RunE:  runInit,
	})

	// pod explore
	exploreCmd := &cobra.Command{
		Use:   "explore",
		Short: "Analyze codebase and generate context for workers",
		RunE:  runExplore,
	}
	exploreCmd.Flags().String("tool", "", "Tool to use for exploration")
	exploreCmd.Flags().String("manual", "", "Path to markdown file to use as context")
	exploreCmd.Flags().Bool("stdin", false, "Read context from stdin")
	root.AddCommand(exploreCmd)

	// pod plan
	planCmd := &cobra.Command{
		Use:   "plan [goal]",
		Short: "Decompose a goal into backlog tasks using an LLM",
		Args:  cobra.MinimumNArgs(1),
		RunE:  runPlan,
	}
	planCmd.Flags().String("tool", "", "Tool to use for decomposition")
	planCmd.Flags().Bool("auto", false, "Skip confirmation and create tasks immediately")
	root.AddCommand(planCmd)

	// pod run
	runCmd := &cobra.Command{
		Use:   "run",
		Short: "Plan, start, review, and integrate in one shot",
		RunE:  runRun,
	}
	runCmd.Flags().Bool("no-integrate", false, "Skip auto-integration after success")
	root.AddCommand(runCmd)

	// pod backlog
	backlog := &cobra.Command{
		Use:   "backlog",
		Short: "Manage task backlog",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	// pod backlog add
	addCmd := &cobra.Command{
		Use:   "add [title]",
		Short: "Add a task to the backlog",
		Args:  cobra.MinimumNArgs(1),
		RunE:  runBacklogAdd,
	}
	addCmd.Flags().String("description", "", "Task description")
	addCmd.Flags().String("parent", "", "Parent task ID")
	addCmd.Flags().StringSlice("depends-on", nil, "Task IDs this task depends on")
	addCmd.Flags().String("tool", "", "Assigned tool")
	backlog.AddCommand(addCmd)

	// pod backlog list
	backlog.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List backlog tasks",
		RunE:  runBacklogList,
	})

	// pod backlog edit
	editCmd := &cobra.Command{
		Use:   "edit [id]",
		Short: "Edit a backlog task",
		Args:  cobra.ExactArgs(1),
		RunE:  runBacklogEdit,
	}
	editCmd.Flags().String("title", "", "New title")
	editCmd.Flags().String("description", "", "New description")
	editCmd.Flags().String("prompt", "", "New prompt")
	editCmd.Flags().String("status", "", "New status")
	editCmd.Flags().String("tool", "", "Assigned tool")
	backlog.AddCommand(editCmd)

	root.AddCommand(backlog)

	// pod sprint
	sprintCmd := &cobra.Command{
		Use:   "sprint",
		Short: "Manage sprint execution",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	sprintCmd.AddCommand(&cobra.Command{
		Use:   "plan",
		Short: "Select next batch of tasks for sprint",
		RunE:  runSprintPlan,
	})
	sprintCmd.AddCommand(&cobra.Command{
		Use:   "start",
		Short: "Execute current sprint batch",
		RunE:  runSprintStart,
	})
	sprintCmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Check worker progress",
		RunE:  runSprintStatus,
	})
	reviewCmd := &cobra.Command{
		Use:   "review",
		Short: "Review completed sprint work",
		RunE:  runSprintReview,
	}
	reviewCmd.Flags().Bool("verbose", false, "Show full diffs")
	reviewCmd.Flags().Bool("auto", false, "Run automated LLM review on each task")
	reviewCmd.Flags().String("review-tool", "", "Tool to use for automated review")
	sprintCmd.AddCommand(reviewCmd)
	sprintCmd.AddCommand(&cobra.Command{
		Use:   "reset",
		Short: "Reset active sprint (cleanup worktrees, revert tasks to pending)",
		RunE:  runSprintReset,
	})
	sprintCmd.AddCommand(&cobra.Command{
		Use:   "cancel",
		Short: "Cancel running sprint and kill workers",
		RunE:  runSprintCancel,
	})
	root.AddCommand(sprintCmd)

	// pod integrate
	integrateCmd := &cobra.Command{
		Use:   "integrate",
		Short: "Merge approved tasks into integration branch",
		RunE:  runIntegrate,
	}
	integrateCmd.Flags().Bool("dry-run", false, "Print what would be merged without doing it")
	root.AddCommand(integrateCmd)

	// pod cleanup
	cleanupCmd := &cobra.Command{
		Use:   "cleanup",
		Short: "Remove stale worktrees",
		RunE:  runCleanup,
	}
	cleanupCmd.Flags().Bool("dry-run", false, "Show what would be removed without removing")
	root.AddCommand(cleanupCmd)

	// pod log
	logCmd := &cobra.Command{
		Use:   "log",
		Short: "Show sprint history",
		RunE:  runLog,
	}
	logCmd.Flags().Bool("all", false, "Show all sprints (default: last 10)")
	root.AddCommand(logCmd)

	// pod status
	root.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show overall project status",
		RunE:  runStatus,
	})

	// pod costs
	costsCmd := &cobra.Command{
		Use:   "costs",
		Short: "Show cost tracking summary",
		RunE:  runCosts,
	}
	costsCmd.Flags().String("sprint", "", "Show costs for specific sprint (prefix ID)")
	root.AddCommand(costsCmd)

	// pod config
	configCmd := &cobra.Command{
		Use:   "config",
		Short: "Manage pod configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	configCmd.AddCommand(&cobra.Command{
		Use:   "show",
		Short: "Print current configuration",
		RunE:  runConfigShow,
	})
	configCmd.AddCommand(&cobra.Command{
		Use:   "set [key] [value]",
		Short: "Set a config value (e.g., autopilot.enabled true)",
		Args:  cobra.ExactArgs(2),
		RunE:  runConfigSet,
	})
	root.AddCommand(configCmd)

	// pod autopilot
	autopilotCmd := &cobra.Command{
		Use:   "autopilot [goal]",
		Short: "Run autonomous explore→plan→sprint→review→integrate loop",
		Args:  cobra.MinimumNArgs(1),
		RunE:  runAutopilot,
	}
	autopilotCmd.Flags().Int("max-sprints", 0, "Maximum number of sprints (0=unlimited)")
	autopilotCmd.Flags().Bool("pause-review", true, "Pause after each review for approval")
	autopilotCmd.Flags().Bool("unattended", false, "Run without any pauses (overrides pause-review)")
	root.AddCommand(autopilotCmd)

	// pod tui
	root.AddCommand(&cobra.Command{
		Use:   "tui",
		Short: "Launch interactive terminal UI",
		RunE:  runTUI,
	})

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func runInit(cmd *cobra.Command, args []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	// Check this is a git repo.
	if _, err := os.Stat(filepath.Join(cwd, ".git")); os.IsNotExist(err) {
		return fmt.Errorf("not a git repository (no .git/ found)")
	}

	// Check if repo has at least one commit.
	headCheck := exec.Command("git", "rev-parse", "HEAD")
	headCheck.Dir = cwd
	if err := headCheck.Run(); err != nil {
		return fmt.Errorf("git repo has no commits — make an initial commit before running 'pod init'")
	}

	podDir := filepath.Join(cwd, ".pod")

	// If already initialized, exit early.
	if _, err := os.Stat(podDir); err == nil {
		fmt.Println("Pod already initialized")
		return nil
	}

	// Create .pod/ directory.
	if err := os.MkdirAll(podDir, 0755); err != nil {
		return fmt.Errorf("create .pod directory: %w", err)
	}

	// Write default config.
	cfg := config.Default()
	cfg.Project.Name = filepath.Base(cwd)
	if err := cfg.Save(filepath.Join(podDir, "pod.yaml")); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	// Create SQLite DB.
	db, err := state.Open(filepath.Join(podDir, "state.db"))
	if err != nil {
		return fmt.Errorf("create database: %w", err)
	}
	db.Close()

	// Create integration branch (ignore error if exists).
	_ = exec.Command("git", "branch", "pod/integration").Run()

	fmt.Printf("Initialized Pod in %s\n", cwd)
	return nil
}

func runExplore(cmd *cobra.Command, args []string) error {
	db, cfg, _, _, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	manualPath, _ := cmd.Flags().GetString("manual")
	useStdin, _ := cmd.Flags().GetBool("stdin")
	repoDir, _ := os.Getwd()

	if manualPath != "" {
		outPath, err := explore.WriteManualContextFromFile(repoDir, manualPath)
		if err != nil {
			return fmt.Errorf("manual explore: %w", err)
		}
		fmt.Printf("Context written to %s (from %s)\n", outPath, manualPath)
		return nil
	}

	if useStdin {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("read stdin: %w", err)
		}
		outPath, err := explore.WriteManualContext(repoDir, string(data))
		if err != nil {
			return fmt.Errorf("stdin explore: %w", err)
		}
		fmt.Printf("Context written to %s (from stdin)\n", outPath)
		return nil
	}

	toolName, _ := cmd.Flags().GetString("tool")
	var toolCfg config.ToolConfig
	if toolName != "" {
		tc, ok := cfg.Tools[toolName]
		if !ok {
			return fmt.Errorf("tool %q not found in config", toolName)
		}
		toolCfg = tc
	} else {
		for _, tc := range cfg.Tools {
			toolCfg = tc
			break
		}
	}

	explorer := explore.New(toolCfg, repoDir)

	fmt.Println("Exploring codebase...")
	outPath, err := explorer.Run()
	if err != nil {
		return fmt.Errorf("explore: %w", err)
	}

	fmt.Printf("Context written to %s\n", outPath)
	return nil
}

func runPlan(cmd *cobra.Command, args []string) error {
	db, cfg, _, _, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	goal := strings.Join(args, " ")
	toolName, _ := cmd.Flags().GetString("tool")
	auto, _ := cmd.Flags().GetBool("auto")

	var toolCfg config.ToolConfig
	if toolName != "" {
		tc, ok := cfg.Tools[toolName]
		if !ok {
			return fmt.Errorf("tool %q not found in config", toolName)
		}
		toolCfg = tc
	} else {
		for _, tc := range cfg.Tools {
			toolCfg = tc
			break
		}
	}

	repoDir, _ := os.Getwd()
	store := task.NewStore(db)
	d := decompose.New(toolCfg, repoDir)

	fmt.Printf("Decomposing: %s\n\n", goal)
	tasks, err := d.Run(goal)
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
		fmt.Print("\nCreate these tasks? [y/N] ")
		var answer string
		fmt.Scanln(&answer)
		if answer != "y" && answer != "Y" {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	// Create tasks, then wire up deps using index mapping.
	createdIDs := make([]string, len(tasks))
	for i, t := range tasks {
		created, err := store.Create(t.Title, t.Description, "", t.SuggestedTool)
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

func runRun(cmd *cobra.Command, args []string) error {
	db, cfg, planner, executor, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	noIntegrate, _ := cmd.Flags().GetBool("no-integrate")

	// Check for existing active sprint.
	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("check active sprint: %w", err)
	}
	if active != nil {
		return fmt.Errorf("sprint %s already active — reset it first", short(active.ID))
	}

	// Plan
	s, err := planner.Plan(cfg.Workers.MaxParallel)
	if err != nil {
		return fmt.Errorf("plan: %w", err)
	}
	fmt.Printf("Planned sprint %s (%d tasks)\n", short(s.ID), len(s.TaskIDs))

	// Start
	fmt.Println("Running...")
	results, err := executor.Run(s)
	if err != nil {
		return fmt.Errorf("run: %w", err)
	}

	var succeeded, failed int
	for _, r := range results {
		t, _ := planner.GetTask(r.TaskID)
		title := r.TaskID
		if t != nil {
			title = t.Title
		}
		fmt.Printf("  %s %s  %s  (%s)\n", statusIcon(r.Status), short(r.TaskID), title, r.Duration.Round(time.Second))
		if r.Status == "failed" {
			failed++
		} else {
			succeeded++
		}
	}
	fmt.Printf("\n%d succeeded, %d failed\n", succeeded, failed)

	if failed > 0 || noIntegrate {
		return nil
	}

	// Auto-integrate
	repoDir, _ := os.Getwd()
	ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)

	var taskIDs []string
	for _, r := range results {
		if r.Status == "completed" {
			taskIDs = append(taskIDs, r.TaskID)
		}
	}

	merged, failedIDs, err := ig.MergeBatch(taskIDs)
	if err != nil {
		return fmt.Errorf("integrate: %w", err)
	}
	fmt.Printf("\nIntegrated: %d merged, %d failed\n", len(merged), len(failedIDs))
	return nil
}

func runBacklogAdd(cmd *cobra.Command, args []string) error {
	db, store := openStore()
	defer db.Close()

	title := strings.Join(args, " ")
	description, _ := cmd.Flags().GetString("description")
	parentID, _ := cmd.Flags().GetString("parent")
	dependsOn, _ := cmd.Flags().GetStringSlice("depends-on")
	toolName, _ := cmd.Flags().GetString("tool")

	// Resolve prefix IDs for --depends-on
	for i, dep := range dependsOn {
		resolved, err := resolveTaskID(store, dep)
		if err != nil {
			return err
		}
		dependsOn[i] = resolved
	}

	t, err := store.Create(title, description, parentID, toolName)
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}

	for _, depID := range dependsOn {
		if err := store.AddDependency(t.ID, depID); err != nil {
			return fmt.Errorf("add dependency: %w", err)
		}
	}

	fmt.Printf("Created task %s: %s\n", short(t.ID), title)
	if toolName != "" {
		fmt.Printf("  tool: %s\n", toolName)
	}
	if len(dependsOn) > 0 {
		shortened := make([]string, len(dependsOn))
		for i, d := range dependsOn {
			shortened[i] = short(d)
		}
		fmt.Printf("  depends on: %s\n", strings.Join(shortened, ", "))
	}
	return nil
}

func runBacklogList(cmd *cobra.Command, args []string) error {
	db, store := openStore()
	defer db.Close()

	tasks, err := store.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}

	if len(tasks) == 0 {
		fmt.Println("No tasks in backlog.")
		return nil
	}

	for _, t := range tasks {
		icon := statusIcon(t.Status)
		line := fmt.Sprintf("%s %s  %s", icon, short(t.ID), t.Title)

		var extras []string
		if len(t.DependsOn) > 0 {
			shortened := make([]string, len(t.DependsOn))
			for i, d := range t.DependsOn {
				shortened[i] = short(d)
			}
			extras = append(extras, "depends on: "+strings.Join(shortened, ", "))
		}
		if t.AssignedTool != "" {
			extras = append(extras, "tool: "+t.AssignedTool)
		}
		if len(extras) > 0 {
			line += "      " + strings.Join(extras, "  ")
		}
		fmt.Println(line)
	}
	return nil
}

func runBacklogEdit(cmd *cobra.Command, args []string) error {
	db, store := openStore()
	defer db.Close()

	id, err := resolveTaskID(store, args[0])
	if err != nil {
		return err
	}
	fields := make(map[string]interface{})

	if cmd.Flags().Changed("title") {
		v, _ := cmd.Flags().GetString("title")
		fields["title"] = v
	}
	if cmd.Flags().Changed("description") {
		v, _ := cmd.Flags().GetString("description")
		fields["description"] = v
	}
	if cmd.Flags().Changed("prompt") {
		v, _ := cmd.Flags().GetString("prompt")
		fields["prompt"] = v
	}
	if cmd.Flags().Changed("status") {
		v, _ := cmd.Flags().GetString("status")
		fields["status"] = v
	}
	if cmd.Flags().Changed("tool") {
		v, _ := cmd.Flags().GetString("tool")
		fields["assigned_tool"] = v
	}

	if len(fields) == 0 {
		fmt.Println("No fields to update. Use --title, --description, --prompt, --status, or --tool.")
		return nil
	}

	if err := store.Update(id, fields); err != nil {
		return fmt.Errorf("update task: %w", err)
	}

	fmt.Printf("Updated task %s\n", short(id))
	return nil
}

func statusIcon(status string) string {
	switch status {
	case "completed":
		return "✓"
	case "running", "in_sprint":
		return "●"
	case "failed":
		return "✗"
	default:
		return "○"
	}
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func resolveTaskID(store *task.Store, prefix string) (string, error) {
	id, err := store.ResolveID(prefix)
	if err != nil {
		return "", fmt.Errorf("resolve %q: %w", prefix, err)
	}
	return id, nil
}

// --- Sprint commands ---

func runSprintPlan(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("check active sprint: %w", err)
	}
	if active != nil {
		return fmt.Errorf("sprint %s already active (status: %s)", short(active.ID), active.Status)
	}

	s, err := planner.Plan(cfg.Workers.MaxParallel)
	if err != nil {
		return fmt.Errorf("plan sprint: %w", err)
	}

	fmt.Printf("Sprint %s planned (%d tasks)\n\n", short(s.ID), len(s.TaskIDs))
	for _, id := range s.TaskIDs {
		t, err := planner.GetTask(id)
		if err != nil {
			return fmt.Errorf("get task %s: %w", id, err)
		}
		fmt.Printf("  %s %s  %s\n", statusIcon(t.Status), short(t.ID), t.Title)
	}
	return nil
}

func runSprintStart(cmd *cobra.Command, args []string) error {
	db, _, planner, executor, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active == nil {
		return fmt.Errorf("no active sprint — run 'pod sprint plan' first")
	}
	if active.Status != "planning" {
		return fmt.Errorf("sprint %s is %s, not planning", short(active.ID), active.Status)
	}

	// Write PID file so `pod sprint cancel` can signal us.
	pidPath := filepath.Join(".pod", "sprint.pid")
	_ = os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0644)
	defer os.Remove(pidPath)

	// Handle SIGINT/SIGTERM for graceful cancel.
	var cancelled atomic.Bool
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		fmt.Printf("\nReceived %s, cancelling sprint...\n", sig)
		cancelled.Store(true)
		executor.Cancel()
	}()

	fmt.Printf("Starting sprint %s...\n\n", short(active.ID))
	results, err := executor.Run(active)

	// Stop signal handler after Run returns.
	signal.Stop(sigCh)

	if cancelled.Load() {
		if cleanupErr := executor.Cleanup(active); cleanupErr != nil {
			fmt.Fprintf(os.Stderr, "warning: worktree cleanup: %v\n", cleanupErr)
		}
		if resetErr := planner.ResetSprintTasks(active.ID); resetErr != nil {
			fmt.Fprintf(os.Stderr, "warning: reset tasks: %v\n", resetErr)
		}
		fmt.Println("Sprint cancelled. Tasks reverted to pending.")
		return nil
	}

	if err != nil {
		return fmt.Errorf("run sprint: %w", err)
	}

	var succeeded, failed int
	for _, r := range results {
		t, _ := planner.GetTask(r.TaskID)
		title := r.TaskID
		if t != nil {
			title = t.Title
		}
		fmt.Printf("  %s %s  %s  (%s)\n", statusIcon(r.Status), short(r.TaskID), title, r.Duration.Round(time.Second))
		if r.Status == "failed" {
			failed++
			if r.Stderr != "" {
				stderr := r.Stderr
				if len(stderr) > 500 {
					stderr = stderr[:500] + "..."
				}
				fmt.Printf("    stderr: %s\n", stderr)
			}
		} else {
			succeeded++
		}
	}

	fmt.Printf("\nSprint complete: %d succeeded, %d failed\n", succeeded, failed)
	return nil
}

func runSprintStatus(cmd *cobra.Command, args []string) error {
	db, _, planner, _, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active == nil {
		fmt.Println("No active sprint")
		return nil
	}

	fmt.Printf("Sprint %s (%s)\n\n", short(active.ID), active.Status)
	for _, id := range active.TaskIDs {
		t, err := planner.GetTask(id)
		if err != nil {
			return fmt.Errorf("get task %s: %w", id, err)
		}
		fmt.Printf("  %s %s  %s\n", statusIcon(t.Status), short(t.ID), t.Title)
	}
	return nil
}

func runSprintReset(cmd *cobra.Command, args []string) error {
	db, _, planner, executor, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}

	// If no active sprint, try the most recent one (handles post-cancel state).
	if active == nil {
		var sprintID string
		err := db.QueryRow(
			`SELECT id FROM sprints ORDER BY created_at DESC LIMIT 1`,
		).Scan(&sprintID)
		if err == sql.ErrNoRows {
			fmt.Println("No sprints to reset")
			return nil
		}
		if err != nil {
			return fmt.Errorf("get latest sprint: %w", err)
		}

		s, err := planner.Get(sprintID)
		if err != nil {
			return fmt.Errorf("get sprint: %w", err)
		}
		if s.Status == "completed" || s.Status == "failed" {
			active = s
		} else {
			fmt.Println("No active or recent sprint to reset")
			return nil
		}
	}

	if err := executor.Cleanup(active); err != nil {
		fmt.Fprintf(os.Stderr, "warning: worktree cleanup: %v\n", err)
	}
	if err := planner.ResetSprintTasks(active.ID); err != nil {
		return fmt.Errorf("reset tasks: %w", err)
	}
	if err := planner.Fail(active.ID); err != nil {
		return fmt.Errorf("fail sprint: %w", err)
	}

	fmt.Printf("Sprint %s reset. Tasks reverted to pending.\n", short(active.ID))
	return nil
}

func runSprintCancel(cmd *cobra.Command, args []string) error {
	db, _, planner, _, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active == nil {
		fmt.Println("No active sprint to cancel")
		return nil
	}
	if active.Status != "running" {
		return fmt.Errorf("sprint %s is %s, not running", short(active.ID), active.Status)
	}

	// Read PID file and signal the sprint start process.
	pidPath := filepath.Join(".pod", "sprint.pid")
	pidData, err := os.ReadFile(pidPath)
	if err != nil {
		return fmt.Errorf("read sprint PID file: %w (is a sprint running?)", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidData)))
	if err != nil {
		return fmt.Errorf("parse sprint PID: %w", err)
	}

	proc, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("find process %d: %w", pid, err)
	}

	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return fmt.Errorf("signal process %d: %w", pid, err)
	}

	fmt.Printf("Sprint %s cancelled. Sent SIGTERM to pid %d.\n", short(active.ID), pid)
	fmt.Println("Tasks will be reverted to pending.")
	return nil
}

func runSprintReview(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	verbose, _ := cmd.Flags().GetBool("verbose")
	auto, _ := cmd.Flags().GetBool("auto")
	reviewToolName, _ := cmd.Flags().GetString("review-tool")

	var sprintID string
	err = db.QueryRow(
		`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`,
	).Scan(&sprintID)
	if err == sql.ErrNoRows {
		fmt.Println("No completed sprints to review")
		return nil
	}
	if err != nil {
		return fmt.Errorf("query sprint: %w", err)
	}

	s, err := planner.Get(sprintID)
	if err != nil {
		return fmt.Errorf("get sprint: %w", err)
	}

	fmt.Printf("Sprint %s (%s)\n\n", short(s.ID), s.Status)

	type taskArtifact struct {
		task       *task.Task
		diff       string
		durationMs int64
		hasArt     bool
	}
	var artifacts []taskArtifact

	for _, taskID := range s.TaskIDs {
		t, err := planner.GetTask(taskID)
		if err != nil {
			return fmt.Errorf("get task %s: %w", taskID, err)
		}

		var diff, stdout, stderr string
		var exitCode int
		var durationMs int64
		artErr := db.QueryRow(
			`SELECT diff, stdout, stderr, exit_code, duration_ms FROM artifacts WHERE task_id = ? AND sprint_id = ?`,
			taskID, sprintID,
		).Scan(&diff, &stdout, &stderr, &exitCode, &durationMs)

		ta := taskArtifact{task: t}

		icon := statusIcon(t.Status)
		if artErr == nil {
			ta.diff = diff
			ta.durationMs = durationMs
			ta.hasArt = true

			dur := time.Duration(durationMs) * time.Millisecond
			fmt.Printf("  %s %s  %s  (%s)\n", icon, short(t.ID), t.Title, dur.Round(time.Second))

			var files []string
			for _, line := range strings.Split(diff, "\n") {
				if strings.HasPrefix(line, "+++ b/") {
					files = append(files, strings.TrimPrefix(line, "+++ b/"))
				}
			}
			if len(files) > 0 {
				fmt.Printf("    files: %s\n", strings.Join(files, ", "))
			}
			if verbose && diff != "" {
				fmt.Printf("\n%s\n", diff)
			}
		} else {
			fmt.Printf("  %s %s  %s\n", icon, short(t.ID), t.Title)
		}

		artifacts = append(artifacts, ta)
	}

	if !auto {
		return nil
	}

	// Resolve review tool: explicit flag > different tool than task's > first available.
	repoDir, _ := os.Getwd()
	resolveReviewTool := func(taskTool string) (config.ToolConfig, error) {
		if reviewToolName != "" {
			tc, ok := cfg.Tools[reviewToolName]
			if !ok {
				return config.ToolConfig{}, fmt.Errorf("review tool %q not found in config", reviewToolName)
			}
			return tc, nil
		}
		for name, tc := range cfg.Tools {
			if name != taskTool {
				return tc, nil
			}
		}
		for _, tc := range cfg.Tools {
			return tc, nil
		}
		return config.ToolConfig{}, fmt.Errorf("no tools configured")
	}

	fmt.Println("\nRunning automated review...")

	var inputs []review.ReviewInput
	var toolForReview config.ToolConfig
	for _, ta := range artifacts {
		if !ta.hasArt || ta.diff == "" || ta.task.Status != "completed" {
			continue
		}
		inputs = append(inputs, review.ReviewInput{
			TaskID:      ta.task.ID,
			Title:       ta.task.Title,
			Description: ta.task.Description,
			Diff:        ta.diff,
		})
		if toolForReview.Binary == "" {
			tc, err := resolveReviewTool(ta.task.AssignedTool)
			if err != nil {
				return fmt.Errorf("resolve review tool: %w", err)
			}
			toolForReview = tc
		}
	}

	if len(inputs) == 0 {
		fmt.Println("No completed tasks with diffs to review.")
		return nil
	}

	reviewer := review.New(toolForReview, repoDir)
	results, err := reviewer.ReviewBatch(inputs)
	if err != nil {
		return fmt.Errorf("run reviews: %w", err)
	}

	fmt.Println()
	var approved, rejected int
	for _, r := range results {
		t, _ := planner.GetTask(r.TaskID)
		title := r.TaskID
		if t != nil {
			title = t.Title
		}
		if r.Approved {
			approved++
			fmt.Printf("  \u2713 Approved: %s\n", title)
		} else {
			rejected++
			fmt.Printf("  \u2717 Rejected: %s\n    feedback: %s\n", title, r.Feedback)
		}
	}
	fmt.Printf("\nReview: %d approved, %d rejected\n", approved, rejected)

	return nil
}

// --- Integrate command ---

func runIntegrate(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	dryRun, _ := cmd.Flags().GetBool("dry-run")

	var sprintID string
	err = db.QueryRow(
		`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`,
	).Scan(&sprintID)
	if err == sql.ErrNoRows {
		fmt.Println("No completed sprints to integrate")
		return nil
	}
	if err != nil {
		return fmt.Errorf("query sprint: %w", err)
	}

	s, err := planner.Get(sprintID)
	if err != nil {
		return fmt.Errorf("get sprint: %w", err)
	}

	// Filter to only completed tasks.
	var taskIDs []string
	for _, id := range s.TaskIDs {
		t, err := planner.GetTask(id)
		if err != nil {
			return fmt.Errorf("get task %s: %w", id, err)
		}
		if t.Status == "completed" {
			taskIDs = append(taskIDs, id)
		}
	}

	if len(taskIDs) == 0 {
		fmt.Println("No completed tasks to integrate")
		return nil
	}

	if dryRun {
		fmt.Println("Dry run — would merge:")
		for _, id := range taskIDs {
			t, _ := planner.GetTask(id)
			title := id
			if t != nil {
				title = t.Title
			}
			fmt.Printf("  ○ task-%s  %s\n", short(id), title)
		}
		return nil
	}

	repoDir, _ := os.Getwd()
	ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)
	store := task.NewStore(db)
	ig.SetRerunConfig(cfg.Project.WorktreeDir, func(taskID string) (config.ToolConfig, error) {
		t, err := store.Get(taskID)
		if err != nil {
			return config.ToolConfig{}, err
		}
		toolName := t.AssignedTool
		if toolName == "" {
			for _, tc := range cfg.Tools {
				return tc, nil
			}
			return config.ToolConfig{}, fmt.Errorf("no tools configured")
		}
		tc, ok := cfg.Tools[toolName]
		if !ok {
			return config.ToolConfig{}, fmt.Errorf("tool %q not found", toolName)
		}
		return tc, nil
	})
	merged, failed, err := ig.MergeBatch(taskIDs)
	if err != nil {
		return fmt.Errorf("merge batch: %w", err)
	}

	for _, id := range merged {
		fmt.Printf("  ✓ Merged task-%s\n", short(id))
	}
	for _, id := range failed {
		fmt.Printf("  ✗ Failed task-%s\n", short(id))
	}
	fmt.Printf("\nIntegrated: %d merged, %d failed\n", len(merged), len(failed))
	return nil
}

// --- Cleanup command ---

func runCleanup(cmd *cobra.Command, args []string) error {
	db, _, _, executor, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	dryRun, _ := cmd.Flags().GetBool("dry-run")
	store := task.NewStore(db)
	wm := executor.Worktrees()

	worktreeList, err := wm.List()
	if err != nil {
		return fmt.Errorf("list worktrees: %w", err)
	}

	type staleEntry struct {
		taskID string
		branch string
		reason string
	}

	var stale []staleEntry
	for _, wt := range worktreeList {
		// Skip main/master worktree
		if wt.Branch == "main" || wt.Branch == "master" || wt.Branch == "" {
			if wt.Branch == "" {
				fmt.Fprintf(os.Stderr, "warning: skipping worktree with no branch: %s\n", wt.Path)
			}
			continue
		}
		// Skip integration branch
		if wt.Branch == "pod/integration" {
			continue
		}
		// Only handle pod/task-{id} branches
		if !strings.HasPrefix(wt.Branch, "pod/task-") {
			continue
		}

		taskID := strings.TrimPrefix(wt.Branch, "pod/task-")
		t, err := store.Get(taskID)
		if err != nil {
			// Orphan — task not found in DB
			stale = append(stale, staleEntry{taskID: taskID, branch: wt.Branch, reason: "orphan"})
			continue
		}
		if t.Status == "completed" || t.Status == "failed" {
			stale = append(stale, staleEntry{taskID: taskID, branch: wt.Branch, reason: t.Status})
		}
	}

	if len(stale) == 0 {
		fmt.Println("No stale worktrees found.")
		return nil
	}

	for _, s := range stale {
		fmt.Printf("  %s  task-%s  (%s)\n", s.branch, short(s.taskID), s.reason)
	}

	if dryRun {
		fmt.Printf("\nDry run: would remove %d worktrees\n", len(stale))
		return nil
	}

	var removed int
	for _, s := range stale {
		if err := wm.Remove(s.taskID); err != nil {
			fmt.Fprintf(os.Stderr, "warning: remove %s: %v\n", s.branch, err)
			continue
		}
		removed++
	}

	fmt.Printf("\nRemoved %d worktrees\n", removed)
	return nil
}

// --- Log command ---

func runLog(cmd *cobra.Command, args []string) error {
	db, _ := openStore()
	defer db.Close()

	showAll, _ := cmd.Flags().GetBool("all")

	query := `SELECT id, status, created_at, completed_at FROM sprints ORDER BY created_at DESC`
	if !showAll {
		query += ` LIMIT 10`
	}

	rows, err := db.Query(query)
	if err != nil {
		return fmt.Errorf("query sprints: %w", err)
	}
	defer rows.Close()

	type sprintRow struct {
		id          string
		status      string
		createdAt   time.Time
		completedAt *time.Time
	}

	var sprints []sprintRow
	for rows.Next() {
		var r sprintRow
		if err := rows.Scan(&r.id, &r.status, &r.createdAt, &r.completedAt); err != nil {
			return fmt.Errorf("scan sprint: %w", err)
		}
		sprints = append(sprints, r)
	}

	if len(sprints) == 0 {
		fmt.Println("No sprints yet.")
		return nil
	}

	for _, s := range sprints {
		var total, completed, failed int
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE sprint_id = ?`, s.id).Scan(&total)
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE sprint_id = ? AND status = 'completed'`, s.id).Scan(&completed)
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE sprint_id = ? AND status = 'failed'`, s.id).Scan(&failed)

		fmt.Printf("Sprint %s  %s  %s\n", short(s.id), s.status, s.createdAt.Format("2006-01-02 15:04"))
		if failed > 0 {
			fmt.Printf("  %d/%d tasks succeeded, %d failed\n", completed, total, failed)
		} else {
			fmt.Printf("  %d/%d tasks succeeded\n", completed, total)
		}
	}
	return nil
}

// --- TUI command ---

func runTUI(cmd *cobra.Command, args []string) error {
	db, cfg, planner, executor, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	repoDir, _ := os.Getwd()
	m := tui.New(db, cfg, planner, executor, repoDir)
	return tui.Run(m)
}

// --- Autopilot command ---

func runAutopilot(cmd *cobra.Command, args []string) error {
	db, cfg, planner, executor, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	goal := strings.Join(args, " ")
	maxSprints, _ := cmd.Flags().GetInt("max-sprints")
	pauseReview, _ := cmd.Flags().GetBool("pause-review")
	unattended, _ := cmd.Flags().GetBool("unattended")

	if unattended {
		pauseReview = false
	}

	repoDir, _ := os.Getwd()
	sup := autopilot.New(db, cfg, planner, executor, repoDir, autopilot.Options{
		MaxSprints:    maxSprints,
		PauseOnReview: pauseReview,
	})

	// Handle SIGINT/SIGTERM.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		fmt.Printf("\nReceived %s, cancelling autopilot...\n", sig)
		if err := sup.Executor().Cancel(); err != nil {
			fmt.Fprintf(os.Stderr, "warning: cancel autopilot: %v\n", err)
		}
		active, err := planner.GetActive()
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: get active sprint: %v\n", err)
		} else if active != nil {
			if err := sup.Executor().Cleanup(active); err != nil {
				fmt.Fprintf(os.Stderr, "warning: worktree cleanup: %v\n", err)
			}
			if err := planner.ResetSprintTasks(active.ID); err != nil {
				fmt.Fprintf(os.Stderr, "warning: reset tasks: %v\n", err)
			}
			if err := planner.Fail(active.ID); err != nil {
				fmt.Fprintf(os.Stderr, "warning: fail sprint: %v\n", err)
			}
		}
		fmt.Println("Autopilot cancelled.")
		os.Exit(1)
	}()

	cb := func(event autopilot.Event) bool {
		switch event.Type {
		case autopilot.EventProgress:
			fmt.Println(event.Message)

		case autopilot.EventExploreComplete:
			fmt.Printf("Explore: %s\n", event.Message)

		case autopilot.EventPlanProposed:
			fmt.Printf("\n%s:\n", event.Message)
			if tasks, ok := event.Data.([]decompose.ProposedTask); ok {
				for i, t := range tasks {
					fmt.Printf("  %d. %s\n", i+1, t.Title)
					if t.Description != "" {
						fmt.Printf("     %s\n", t.Description)
					}
				}
			}
			if !unattended {
				fmt.Print("\nProceed? [Y/n] ")
				var answer string
				fmt.Scanln(&answer)
				if answer == "n" || answer == "N" {
					return false
				}
			}

		case autopilot.EventSprintComplete:
			fmt.Printf("\n%s\n", event.Message)
			if results, ok := event.Data.([]sprint.TaskResult); ok {
				for _, r := range results {
					t, _ := planner.GetTask(r.TaskID)
					title := r.TaskID[:8]
					if t != nil {
						title = t.Title
					}
					fmt.Printf("  %s %s  %s  (%s)\n", statusIcon(r.Status), short(r.TaskID), title, r.Duration.Round(time.Second))
				}
			}

		case autopilot.EventReviewComplete:
			fmt.Printf("\n%s\n", event.Message)

		case autopilot.EventIntegrateComplete:
			fmt.Printf("%s\n", event.Message)

		case autopilot.EventEscalation:
			fmt.Printf("\n⚠ %s\n", event.Message)
			if !unattended {
				fmt.Print("Continue? [Y/n] ")
				var answer string
				fmt.Scanln(&answer)
				if answer == "n" || answer == "N" {
					return false
				}
			}
		}
		return true
	}

	err = sup.Run(goal, cb)
	signal.Stop(sigCh)
	return err
}

// --- Config commands ---

func runConfigShow(cmd *cobra.Command, args []string) error {
	cfgPath := filepath.Join(".pod", "pod.yaml")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return err
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	fmt.Print(string(data))
	return nil
}

func runConfigSet(cmd *cobra.Command, args []string) error {
	cfgPath := filepath.Join(".pod", "pod.yaml")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return err
	}

	key, value := args[0], args[1]

	switch key {
	case "autopilot.enabled":
		b, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("invalid bool %q: %w", value, err)
		}
		cfg.Autopilot.Enabled = b
	case "autopilot.cost_budget":
		f, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return fmt.Errorf("invalid float %q: %w", value, err)
		}
		cfg.Autopilot.CostBudget = f
	case "autopilot.max_sprints":
		n, err := strconv.Atoi(value)
		if err != nil {
			return fmt.Errorf("invalid int %q: %w", value, err)
		}
		cfg.Autopilot.MaxSprints = n
	case "autopilot.pause_on_review":
		b, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("invalid bool %q: %w", value, err)
		}
		cfg.Autopilot.PauseOnReview = b
	case "autopilot.escalate_after_retries":
		n, err := strconv.Atoi(value)
		if err != nil {
			return fmt.Errorf("invalid int %q: %w", value, err)
		}
		cfg.Autopilot.EscalateAfterRetries = n
	case "autopilot.supervisor_tool":
		cfg.Autopilot.SupervisorTool = value
	case "workers.max_parallel":
		n, err := strconv.Atoi(value)
		if err != nil {
			return fmt.Errorf("invalid int %q: %w", value, err)
		}
		cfg.Workers.MaxParallel = n
	default:
		return fmt.Errorf("unknown config key: %s", key)
	}

	if err := cfg.Save(cfgPath); err != nil {
		return err
	}
	fmt.Printf("Set %s = %s\n", key, value)
	return nil
}

// --- Costs command ---

func runCosts(cmd *cobra.Command, args []string) error {
	db, _ := openStore()
	defer db.Close()

	cfg, err := config.Load(filepath.Join(".pod", "pod.yaml"))
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	ct := cost.NewTracker(db)
	sprintFlag, _ := cmd.Flags().GetString("sprint")

	if sprintFlag != "" {
		// Resolve sprint ID by prefix.
		var sprintID string
		err := db.QueryRow(
			`SELECT id FROM sprints WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1`,
			sprintFlag+"%",
		).Scan(&sprintID)
		if err != nil {
			return fmt.Errorf("no sprint matching %q", sprintFlag)
		}

		total, _ := ct.SprintTotal(sprintID)
		fmt.Printf("Sprint %s costs: $%.2f\n\n", short(sprintID), total)

		summary, err := ct.SprintSummary(sprintID)
		if err != nil {
			return err
		}
		if len(summary) == 0 {
			fmt.Println("No cost data recorded for this sprint.")
			return nil
		}

		fmt.Println("By tool:")
		for _, s := range summary {
			fmt.Printf("  %-10s $%.2f  (%s in / %s out tokens)\n",
				s.Tool+":", s.Cost,
				formatTokens(s.InputTokens), formatTokens(s.OutputTokens))
		}
		return nil
	}

	// Project-wide summary.
	projectTotal, _ := ct.ProjectTotal()
	if projectTotal == 0 {
		// Check if there are any cost records at all.
		var count int
		db.QueryRow(`SELECT COUNT(*) FROM costs`).Scan(&count)
		if count == 0 {
			fmt.Println("No cost data recorded yet.")
			return nil
		}
	}

	fmt.Printf("Project costs: $%.2f\n\n", projectTotal)

	summary, _ := ct.ProjectSummary()
	if len(summary) > 0 {
		fmt.Println("By tool:")
		for _, s := range summary {
			fmt.Printf("  %-10s $%.2f  (%s in / %s out tokens)\n",
				s.Tool+":", s.Cost,
				formatTokens(s.InputTokens), formatTokens(s.OutputTokens))
		}
	}

	// Per-sprint breakdown (last 10).
	rows, err := db.Query(
		`SELECT s.id, COALESCE(SUM(c.estimated_cost), 0), COUNT(DISTINCT c.task_id)
		 FROM sprints s
		 LEFT JOIN costs c ON c.sprint_id = s.id
		 GROUP BY s.id
		 ORDER BY s.created_at DESC
		 LIMIT 10`,
	)
	if err == nil {
		defer rows.Close()
		fmt.Println("\nRecent sprints:")
		for rows.Next() {
			var id string
			var sprintCost float64
			var taskCount int
			if err := rows.Scan(&id, &sprintCost, &taskCount); err != nil {
				continue
			}
			if sprintCost > 0 {
				fmt.Printf("  Sprint %s  $%.2f  (%d tasks)\n", short(id), sprintCost, taskCount)
			}
		}
	}

	// Budget info.
	budget := cfg.Autopilot.CostBudget
	if budget > 0 {
		remaining, _ := ct.BudgetRemaining(budget)
		fmt.Printf("\nBudget: $%.2f  remaining: $%.2f\n", budget, remaining)
	} else {
		fmt.Println("\nBudget: unlimited")
	}

	return nil
}

func formatTokens(n int64) string {
	if n >= 1_000_000 {
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
	if n >= 1_000 {
		return fmt.Sprintf("%s", formatWithCommas(n))
	}
	return fmt.Sprintf("%d", n)
}

func formatWithCommas(n int64) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var result []byte
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			result = append(result, ',')
		}
		result = append(result, byte(c))
	}
	return string(result)
}

// --- Status command ---

func runStatus(cmd *cobra.Command, args []string) error {
	db, store := openStore()
	defer db.Close()

	cfg, err := config.Load(filepath.Join(".pod", "pod.yaml"))
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	tasks, err := store.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}

	counts := map[string]int{}
	for _, t := range tasks {
		counts[t.Status]++
	}

	planner := sprint.NewPlanner(db)
	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}

	fmt.Printf("Pod status: %s\n\n", cfg.Project.Name)
	fmt.Printf("Tasks: %d total\n", len(tasks))
	fmt.Printf("  ○ pending:     %d\n", counts["pending"])
	fmt.Printf("  ● in progress: %d\n", counts["in_sprint"]+counts["running"])
	fmt.Printf("  ✓ completed:   %d\n", counts["completed"])
	fmt.Printf("  ✗ failed:      %d\n", counts["failed"])

	if active != nil {
		fmt.Printf("\nSprint: %s (%s)\n", short(active.ID), active.Status)
	} else {
		fmt.Println("\nSprint: none active")
	}
	return nil
}
