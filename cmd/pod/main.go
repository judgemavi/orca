package main

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"io/fs"
	"net/http"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/pod/internal/api"
	"github.com/jasjeetmavi/pod/internal/autopilot"
	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/cost"
	"github.com/jasjeetmavi/pod/internal/decompose"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/integrator"
	"github.com/jasjeetmavi/pod/internal/model"
	planpkg "github.com/jasjeetmavi/pod/internal/plan"
	"github.com/jasjeetmavi/pod/internal/review"
	"github.com/jasjeetmavi/pod/internal/sprint"
	"github.com/jasjeetmavi/pod/internal/state"
	"github.com/jasjeetmavi/pod/internal/task"
	"github.com/jasjeetmavi/pod/internal/tasklog"
	"github.com/jasjeetmavi/pod/internal/tui"
	"github.com/jasjeetmavi/pod/internal/worktree"
	"github.com/jasjeetmavi/pod/web"
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
	initCmd := &cobra.Command{
		Use:   "init",
		Short: "Initialize Pod in current git repo",
		RunE:  runInit,
	}
	initCmd.Flags().BoolP("yes", "y", false, "Accept defaults and skip prompts")
	root.AddCommand(initCmd)

	// pod models
	modelsCmd := &cobra.Command{
		Use:   "models [tool]",
		Short: "List available models for configured tools",
		Args:  cobra.MaximumNArgs(1),
		RunE:  runModels,
	}
	root.AddCommand(modelsCmd)

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
	addCmd.Flags().String("model", "", "Assigned model")
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
	editCmd.Flags().String("model", "", "Assigned model")
	backlog.AddCommand(editCmd)
	deleteCmd := &cobra.Command{
		Use:   "delete [task-id]",
		Short: "Delete a backlog task",
		Args:  cobra.ExactArgs(1),
		RunE:  runBacklogDelete,
	}
	deleteCmd.Flags().BoolP("yes", "y", false, "Skip confirmation")
	backlog.AddCommand(deleteCmd)
	mergeBacklogCmd := &cobra.Command{
		Use:   "merge [task-id]",
		Short: "Merge a completed backlog task into integration branch",
		Args:  cobra.ExactArgs(1),
		RunE:  runBacklogMerge,
	}
	mergeBacklogCmd.Flags().Bool("auto", false, "Auto-resolve merge conflicts by rerunning task in worktree")
	backlog.AddCommand(mergeBacklogCmd)
	planBacklogCmd := &cobra.Command{
		Use:   "plan [task-id]",
		Short: "Generate an implementation plan for a backlog task",
		Args:  cobra.ExactArgs(1),
		RunE:  runBacklogPlan,
	}
	planBacklogCmd.Flags().Bool("save", false, "Save generated plan to the task")
	planBacklogCmd.Flags().Bool("edit", false, "Open generated plan in $EDITOR and save edits")
	planBacklogCmd.Flags().String("tool", "", "Tool to use for plan generation")
	planBacklogCmd.Flags().String("model", "", "Model to use for plan generation")
	backlog.AddCommand(planBacklogCmd)
	backlog.AddCommand(&cobra.Command{
		Use:   "show [task-id]",
		Short: "Show full task details",
		Args:  cobra.ExactArgs(1),
		RunE:  runBacklogShow,
	})
	backlog.AddCommand(&cobra.Command{
		Use:   "reopen [task-id...]",
		Short: "Move failed tasks back to pending",
		Args:  cobra.MinimumNArgs(1),
		RunE:  runBacklogReopen,
	})

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
	sprintCmd.AddCommand(&cobra.Command{
		Use:   "assign [task-id...]",
		Short: "Add tasks to the current sprint",
		Args:  cobra.MinimumNArgs(1),
		RunE:  runSprintAssign,
	})
	sprintCmd.AddCommand(&cobra.Command{
		Use:   "unassign [task-id...]",
		Short: "Remove tasks from the current sprint",
		Args:  cobra.MinimumNArgs(1),
		RunE:  runSprintUnassign,
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

	// pod logs
	logsCmd := &cobra.Command{
		Use:   "logs [task-id]",
		Short: "Show per-task worker logs",
		Args:  cobra.MaximumNArgs(1),
		RunE:  runLogs,
	}
	logsCmd.Flags().BoolP("follow", "f", false, "Follow log output")
	logsCmd.Flags().IntP("tail", "n", 0, "Show last N lines")
	logsCmd.Flags().Bool("all", false, "List all available task log files")
	root.AddCommand(logsCmd)

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
	opsCmd := &cobra.Command{
		Use:   "ops",
		Short: "List tracked operations",
		RunE:  runOps,
	}
	opsCmd.Flags().Bool("all", false, "Include historical completed/failed operations")
	root.AddCommand(opsCmd)

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
	autopilotRespondCmd := &cobra.Command{
		Use:   "respond",
		Short: "Respond to a running web autopilot prompt",
		RunE:  runAutopilotRespond,
	}
	autopilotRespondCmd.Flags().Bool("continue", true, "Send continue=true (set false to decline)")
	autopilotRespondCmd.Flags().String("addr", "http://127.0.0.1:8080", "Pod server base URL")
	autopilotCmd.AddCommand(autopilotRespondCmd)
	root.AddCommand(autopilotCmd)

	// pod serve
	serveCmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the Pod web server",
		RunE:  runServe,
	}
	serveCmd.Flags().String("addr", ":8080", "Listen address")
	root.AddCommand(serveCmd)

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
	yes, _ := cmd.Flags().GetBool("yes")
	scanner := bufio.NewScanner(os.Stdin)

	podDir := filepath.Join(cwd, ".pod")

	// If already initialized, do not overwrite unless user confirms.
	if _, err := os.Stat(podDir); err == nil {
		fmt.Println("Pod already initialized. Run 'pod config' to view settings.")
		reinit := false
		if !yes {
			ok, promptErr := promptYesNo(scanner, "Reinitialize? This will reset your config. [y/N] ", false)
			if promptErr != nil {
				return promptErr
			}
			reinit = ok
		}
		if !reinit {
			return nil
		}
	}

	if _, err := os.Stat(filepath.Join(cwd, ".git")); os.IsNotExist(err) {
		initRepo := yes
		if !yes {
			ok, promptErr := promptYesNo(scanner, "No git repository found. Initialize one? [Y/n] ", true)
			if promptErr != nil {
				return promptErr
			}
			initRepo = ok
		}
		if !initRepo {
			return fmt.Errorf("pod init requires a git repository")
		}
		initCmd := exec.Command("git", "init")
		initCmd.Dir = cwd
		if err := initCmd.Run(); err != nil {
			return fmt.Errorf("git init: %w", err)
		}
	}

	// Ensure repo has at least one commit.
	headCheck := exec.Command("git", "rev-parse", "HEAD")
	headCheck.Dir = cwd
	if err := headCheck.Run(); err != nil {
		fmt.Println("Git repo has no commits. Creating initial commit...")
		addCmd := exec.Command("git", "add", "-A")
		addCmd.Dir = cwd
		if err := addCmd.Run(); err != nil {
			return fmt.Errorf("git add -A: %w", err)
		}

		hasStaged := exec.Command("git", "diff", "--cached", "--quiet")
		hasStaged.Dir = cwd
		commitArgs := []string{"commit", "-m", "Initial commit"}
		if err := hasStaged.Run(); err == nil {
			commitArgs = []string{"commit", "--allow-empty", "-m", "Initial commit"}
		}
		commitCmd := exec.Command("git", commitArgs...)
		commitCmd.Dir = cwd
		if err := commitCmd.Run(); err != nil {
			return fmt.Errorf("create initial commit: %w", err)
		}
	}

	projectNameDefault := filepath.Base(cwd)
	integrationBranchDefault := "pod/integration"
	maxParallelDefault := 2

	projectName, err := promptString(scanner, yes, fmt.Sprintf("Project name [%s]: ", projectNameDefault), projectNameDefault)
	if err != nil {
		return err
	}
	integrationBranch, err := promptString(scanner, yes, fmt.Sprintf("Integration branch [%s]: ", integrationBranchDefault), integrationBranchDefault)
	if err != nil {
		return err
	}

	// Detect installed tools.
	fmt.Println("Detecting tools...")
	available := detectTools()
	if len(available) == 0 {
		return fmt.Errorf("no supported tools found on PATH (need at least one of: claude, codex, aider)")
	}
	for _, name := range []string{"claude", "codex", "aider"} {
		found := false
		for _, a := range available {
			if a == name {
				found = true
				break
			}
		}
		if found {
			fmt.Printf("  ✓ %s\n", name)
		} else {
			fmt.Printf("  ✗ %s (not found)\n", name)
		}
	}
	fmt.Printf("Enabled tools: %s\n", strings.Join(available, ", "))

	// Pick default from detected tools.
	defaultToolDefault := available[0]
	defaultTool, err := promptTool(
		scanner,
		yes,
		fmt.Sprintf("Default tool (%s) [%s]: ", strings.Join(available, "/"), defaultToolDefault),
		defaultToolDefault,
		available...,
	)
	if err != nil {
		return err
	}
	maxParallel, err := promptInt(scanner, yes, fmt.Sprintf("Max parallel workers [%d]: ", maxParallelDefault), maxParallelDefault)
	if err != nil {
		return err
	}

	// Create .pod/ directory.
	if err := os.MkdirAll(podDir, 0755); err != nil {
		return fmt.Errorf("create .pod directory: %w", err)
	}

	cfgPath := filepath.Join(podDir, "pod.yaml")
	dbPath := filepath.Join(podDir, "state.db")

	cfg := config.Default()
	cfg.Project.Name = projectName
	cfg.Project.IntegrationBranch = integrationBranch
	cfg.Workers.MaxParallel = maxParallel
	// Keep only detected tools in config.
	detected := make(map[string]config.ToolConfig)
	for _, name := range available {
		if tc, ok := cfg.Tools[name]; ok {
			detected[name] = tc
		}
	}
	if len(detected) == 0 {
		return fmt.Errorf("none of the detected tools are present in config defaults")
	}
	if _, ok := detected[defaultTool]; !ok {
		return fmt.Errorf("default tool %q not present in detected tool config", defaultTool)
	}
	cfg.Tools = detected

	if !yes {
		fmt.Println("Set default model per tool (press Enter to skip):")
		for _, toolName := range available {
			tc := cfg.Tools[toolName]
			models := model.FromConfig(toolName, tc)
			if len(models) > 0 {
				preview := make([]string, 0, 3)
				for i := 0; i < len(models) && i < 3; i++ {
					preview = append(preview, models[i].ID)
				}
				fmt.Printf("  %s models: %s\n", toolName, strings.Join(preview, ", "))
			}

			value, promptErr := promptString(scanner, false, fmt.Sprintf("  Default model for %s []: ", toolName), "")
			if promptErr != nil {
				return promptErr
			}
			tc.Model = strings.TrimSpace(value)
			cfg.Tools[toolName] = tc
		}
	}

	if err := cfg.Save(cfgPath); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	// Create SQLite DB if missing.
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		db, err := state.Open(dbPath)
		if err != nil {
			return fmt.Errorf("create database: %w", err)
		}
		db.Close()
	}

	// Create integration branch from HEAD.
	branchCmd := exec.Command("git", "branch", integrationBranch)
	branchCmd.Dir = cwd
	if err := branchCmd.Run(); err != nil {
		checkCmd := exec.Command("git", "rev-parse", "--verify", integrationBranch)
		checkCmd.Dir = cwd
		if checkCmd.Run() != nil {
			return fmt.Errorf("failed to create integration branch: %w", err)
		}
	}

	if err := ensurePodIgnored(cwd); err != nil {
		return err
	}

	fmt.Printf("✓ Pod initialized in %s\n\n", cwd)
	fmt.Println("Getting started:")
	fmt.Println("  pod backlog add \"task title\"     Add tasks to the backlog")
	fmt.Println("  pod backlog                      View all tasks")
	fmt.Println("  pod backlog edit <id> --tool codex  Assign a tool")
	fmt.Println("  pod sprint plan                  Plan a sprint from ready tasks")
	fmt.Println("  pod sprint assign <id>           Manually add task to sprint")
	fmt.Println("  pod start                        Execute the sprint")
	fmt.Println("  pod review                       Review completed work")
	fmt.Println("  pod integrate                    Merge into integration branch")
	fmt.Println("  pod serve                        Open web UI at localhost:8080")
	fmt.Println()
	fmt.Println("Tip: Run 'pod explore' to analyze your codebase before planning.")
	return nil
}

func promptString(scanner *bufio.Scanner, yes bool, prompt, defaultValue string) (string, error) {
	if yes {
		return defaultValue, nil
	}
	fmt.Print(prompt)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return "", fmt.Errorf("read input: %w", err)
		}
		return defaultValue, nil
	}
	input := strings.TrimSpace(scanner.Text())
	if input == "" {
		return defaultValue, nil
	}
	return input, nil
}

func detectTools() []string {
	candidates := []string{"claude", "codex", "aider"}
	var found []string
	for _, name := range candidates {
		if _, err := exec.LookPath(name); err == nil {
			found = append(found, name)
		}
	}
	return found
}

func promptTool(scanner *bufio.Scanner, yes bool, prompt, defaultValue string, valid ...string) (string, error) {
	validSet := map[string]bool{}
	for _, v := range valid {
		validSet[v] = true
	}
	for {
		value, err := promptString(scanner, yes, prompt, defaultValue)
		if err != nil {
			return "", err
		}
		if validSet[value] {
			return value, nil
		}
		if yes {
			return "", fmt.Errorf("invalid default tool %q", value)
		}
		fmt.Printf("Please enter one of: %s\n", strings.Join(valid, ", "))
	}
}

func promptInt(scanner *bufio.Scanner, yes bool, prompt string, defaultValue int) (int, error) {
	for {
		value, err := promptString(scanner, yes, prompt, strconv.Itoa(defaultValue))
		if err != nil {
			return 0, err
		}
		n, parseErr := strconv.Atoi(value)
		if parseErr != nil || n <= 0 {
			if yes {
				return 0, fmt.Errorf("invalid integer %q", value)
			}
			fmt.Println("Please enter a positive integer.")
			continue
		}
		return n, nil
	}
}

func promptYesNo(scanner *bufio.Scanner, prompt string, defaultYes bool) (bool, error) {
	fmt.Print(prompt)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return false, fmt.Errorf("read input: %w", err)
		}
		return defaultYes, nil
	}
	value := strings.ToLower(strings.TrimSpace(scanner.Text()))
	if value == "" {
		return defaultYes, nil
	}
	switch value {
	case "y", "yes":
		return true, nil
	case "n", "no":
		return false, nil
	default:
		return defaultYes, nil
	}
}

func ensurePodIgnored(cwd string) error {
	gitignorePath := filepath.Join(cwd, ".gitignore")
	existing, err := os.ReadFile(gitignorePath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read .gitignore: %w", err)
	}

	entries := []string{".pod/state.db", ".pod/state.db-wal", ".pod/state.db-shm", ".pod/prompts/", ".pod/logs/"}
	var needed []string
	for _, e := range entries {
		if !containsIgnoreEntry(existing, e) {
			needed = append(needed, e)
		}
	}
	if len(needed) == 0 {
		return nil
	}

	f, err := os.OpenFile(gitignorePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open .gitignore: %w", err)
	}
	defer f.Close()

	if len(existing) > 0 && !strings.HasSuffix(string(existing), "\n") {
		if _, err := f.WriteString("\n"); err != nil {
			return fmt.Errorf("update .gitignore: %w", err)
		}
	}
	if _, err := f.WriteString("# Pod orchestrator\n"); err != nil {
		return fmt.Errorf("update .gitignore: %w", err)
	}
	for _, e := range needed {
		if _, err := f.WriteString(e + "\n"); err != nil {
			return fmt.Errorf("update .gitignore: %w", err)
		}
	}

	return nil
}

func containsIgnoreEntry(data []byte, entry string) bool {
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == entry {
			return true
		}
	}
	return false
}

func runModels(cmd *cobra.Command, args []string) error {
	cfgPath := filepath.Join(".pod", "pod.yaml")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("pod not initialized — run 'pod init' first")
		}
		return fmt.Errorf("load config: %w", err)
	}

	var toolNames []string
	if len(args) == 1 {
		toolName := args[0]
		if _, ok := cfg.Tools[toolName]; !ok {
			return fmt.Errorf("tool %q not found in config", toolName)
		}
		toolNames = []string{toolName}
	} else {
		toolNames = make([]string, 0, len(cfg.Tools))
		for name := range cfg.Tools {
			toolNames = append(toolNames, name)
		}
		sort.Strings(toolNames)
	}

	multi := len(toolNames) > 1
	for i, toolName := range toolNames {
		tc := cfg.Tools[toolName]
		models := model.FromConfig(toolName, tc)

		if multi {
			if i > 0 {
				fmt.Println()
			}
			fmt.Printf("%s\n", toolName)
		}
		fmt.Printf("%-40s %s\n", "MODEL ID", "PROVIDER")
		for _, m := range models {
			fmt.Printf("%-40s %s\n", m.ID, m.Provider)
		}
		if len(models) == 0 {
			fmt.Println("(no models configured)")
		}
	}

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
	modelName, _ := cmd.Flags().GetString("model")

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
	if modelName != "" {
		if err := store.Update(t.ID, map[string]interface{}{"model": modelName}); err != nil {
			return fmt.Errorf("set model: %w", err)
		}
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
	if modelName != "" {
		fmt.Printf("  model: %s\n", modelName)
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
		if t.Model != "" {
			extras = append(extras, "model: "+t.Model)
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
	if cmd.Flags().Changed("model") {
		v, _ := cmd.Flags().GetString("model")
		fields["model"] = v
	}

	if len(fields) == 0 {
		fmt.Println("No fields to update. Use --title, --description, --prompt, --status, --tool, or --model.")
		return nil
	}

	if err := store.Update(id, fields); err != nil {
		return fmt.Errorf("update task: %w", err)
	}

	fmt.Printf("Updated task %s\n", short(id))
	return nil
}

func runBacklogDelete(cmd *cobra.Command, args []string) error {
	db, store := openStore()
	defer db.Close()

	id, err := resolveTaskID(store, args[0])
	if err != nil {
		return err
	}
	t, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}

	yes, _ := cmd.Flags().GetBool("yes")
	if !yes {
		scanner := bufio.NewScanner(os.Stdin)
		ok, err := promptYesNo(scanner, fmt.Sprintf("Delete task %s (%s)? [y/N] ", short(t.ID), t.Title), false)
		if err != nil {
			return err
		}
		if !ok {
			fmt.Println("Aborted.")
			return nil
		}
	}

	if err := store.Delete(id); err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	fmt.Printf("Deleted task %s: %s\n", short(t.ID), t.Title)
	return nil
}

func runBacklogMerge(cmd *cobra.Command, args []string) error {
	db, cfg, _, executor, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	auto, _ := cmd.Flags().GetBool("auto")
	store := task.NewStore(db)

	id, err := resolveTaskID(store, args[0])
	if err != nil {
		return err
	}
	tk, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}
	if tk.Status != "completed" {
		return fmt.Errorf("only completed tasks can be merged (task %s is %s)", short(id), tk.Status)
	}
	for _, depID := range tk.DependsOn {
		dep, err := store.Get(depID)
		if err != nil {
			return fmt.Errorf("check dependency %s: %w", short(depID), err)
		}
		if dep.Status != "merged" {
			return fmt.Errorf("dependency %q (%s) must be merged first", dep.Title, short(dep.ID))
		}
	}

	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "merge", id)
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
	}

	repoDir, _ := os.Getwd()
	ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)
	if auto {
		ig.SetRerunConfig(cfg.Project.WorktreeDir, func(taskID string) (config.ToolConfig, error) {
			taskRow, err := store.Get(taskID)
			if err != nil {
				return config.ToolConfig{}, err
			}
			if taskRow.AssignedTool != "" {
				if tc, ok := cfg.Tools[taskRow.AssignedTool]; ok {
					return tc, nil
				}
				return config.ToolConfig{}, fmt.Errorf("tool %q not found", taskRow.AssignedTool)
			}
			for _, tc := range cfg.Tools {
				return tc, nil
			}
			return config.ToolConfig{}, fmt.Errorf("no tools configured")
		})
	}

	fmt.Printf("Merging task %s (op %s)\n", short(id), short(opID))
	if auto {
		fmt.Println("Auto-resolving conflicts is enabled.")
	}

	var mergeErr error
	if auto {
		mergeErr = ig.MergeWithRerun(id)
	} else {
		mergeErr = ig.MergeAndValidate(id)
	}
	if mergeErr != nil {
		_ = failOperation(db, opID, mergeErr.Error())
		if strings.Contains(strings.ToLower(mergeErr.Error()), "conflict") {
			worktreePath := filepath.Join(cfg.Project.WorktreeDir, "task-"+id)
			return fmt.Errorf("merge conflict for task %s (worktree: %s): %w", short(id), worktreePath, mergeErr)
		}
		return fmt.Errorf("merge task %s: %w", short(id), mergeErr)
	}

	if err := store.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
		_ = failOperation(db, opID, err.Error())
		return fmt.Errorf("set merged status: %w", err)
	}
	if err := executor.Worktrees().Remove(id); err != nil {
		fmt.Fprintf(os.Stderr, "warning: cleanup worktree after merge %s: %v\n", short(id), err)
	}
	if err := completeOperation(db, opID, map[string]string{"status": "merged", "task_id": id}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}

	fmt.Printf("Merged task %s\n", short(id))
	return nil
}

func runBacklogPlan(cmd *cobra.Command, args []string) error {
	db, store := openStore()
	defer db.Close()

	cfg, err := config.Load(filepath.Join(".pod", "pod.yaml"))
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	id, err := resolveTaskID(store, args[0])
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

	toolName := toolOverride
	if toolName == "" {
		toolName = t.AssignedTool
	}
	if toolName == "" {
		toolNames := make([]string, 0, len(cfg.Tools))
		for name := range cfg.Tools {
			toolNames = append(toolNames, name)
		}
		sort.Strings(toolNames)
		if len(toolNames) == 0 {
			return fmt.Errorf("no tools configured")
		}
		toolName = toolNames[0]
	}

	toolCfg, ok := cfg.Tools[toolName]
	if !ok {
		return fmt.Errorf("tool %q not found in config", toolName)
	}

	modelName := modelOverride
	if modelName == "" && t.Model != "" {
		modelName = t.Model
	}

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	generator := planpkg.New(toolCfg, repoDir)
	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "plan_generate", id)
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
	}

	fmt.Printf("Generating plan for task %s (op %s)\n", short(id), short(opID))
	var planContent string
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
		_ = failOperation(db, opID, err.Error())
		return fmt.Errorf("generate plan: %w", err)
	}
	if err := completeOperation(db, opID, map[string]string{"task_id": id, "plan": planContent}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
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

	tmpFile, err := os.CreateTemp("", "pod-plan-*.md")
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

func runBacklogShow(cmd *cobra.Command, args []string) error {
	db, store := openStore()
	defer db.Close()

	id, err := resolveTaskID(store, args[0])
	if err != nil {
		return err
	}
	t, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}

	fmt.Printf("ID: %s\n", t.ID)
	fmt.Printf("Title: %s\n", t.Title)
	fmt.Printf("Description: %s\n", t.Description)
	fmt.Printf("Status: %s\n", t.Status)
	if t.AssignedTool != "" {
		fmt.Printf("Tool: %s\n", t.AssignedTool)
	} else {
		fmt.Println("Tool: (none)")
	}
	if t.Model != "" {
		fmt.Printf("Model: %s\n", t.Model)
	} else {
		fmt.Println("Model: (none)")
	}

	if len(t.DependsOn) == 0 {
		fmt.Println("Dependencies: (none)")
	} else {
		shortened := make([]string, len(t.DependsOn))
		for i, dep := range t.DependsOn {
			shortened[i] = short(dep)
		}
		fmt.Printf("Dependencies: %s\n", strings.Join(shortened, ", "))
	}

	fmt.Println("Plan:")
	if strings.TrimSpace(t.Plan) == "" {
		fmt.Println("(none)")
	} else {
		fmt.Println(t.Plan)
	}
	return nil
}

func runBacklogReopen(cmd *cobra.Command, args []string) error {
	db, store := openStore()
	defer db.Close()

	var reopened int
	var lastReopenedID string
	for _, arg := range args {
		id, err := resolveTaskID(store, arg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			continue
		}

		t, err := store.Get(id)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: get task %s: %v\n", short(id), err)
			continue
		}
		if t.Status != "failed" {
			fmt.Fprintf(os.Stderr, "Error: task %s is %q, not %q\n", short(id), t.Status, "failed")
			continue
		}

		if err := store.Update(id, map[string]interface{}{"status": "pending", "sprint_id": nil}); err != nil {
			fmt.Fprintf(os.Stderr, "Error: reopen task %s: %v\n", short(id), err)
			continue
		}
		reopened++
		lastReopenedID = id
	}

	if reopened == 1 {
		fmt.Printf("Reopened task %s -> pending\n", short(lastReopenedID))
		return nil
	}
	if reopened > 1 {
		fmt.Printf("Reopened %d tasks -> pending\n", reopened)
	}
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

type operationRow struct {
	ID        string
	Type      string
	TargetID  string
	Status    string
	Result    string
	Error     string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func ensureOperationsTable(db *state.DB) error {
	_, err := db.Exec(`
CREATE TABLE IF NOT EXISTS operations (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'running',
	result TEXT,
	error TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`)
	return err
}

func createOperation(db *state.DB, opType, targetID string) (string, error) {
	id := uuid.New().String()
	now := time.Now().UTC()
	_, err := db.Exec(
		`INSERT INTO operations (id, type, target_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)`,
		id, opType, targetID, now, now,
	)
	if err != nil {
		return "", err
	}
	return id, nil
}

func completeOperation(db *state.DB, id string, result interface{}) error {
	resultJSON, err := marshalOperationResult(result)
	if err != nil {
		return err
	}
	_, err = db.Exec(
		`UPDATE operations SET status = 'completed', result = ?, error = NULL, updated_at = ? WHERE id = ?`,
		resultJSON, time.Now().UTC(), id,
	)
	return err
}

func failOperation(db *state.DB, id, errMsg string) error {
	_, err := db.Exec(
		`UPDATE operations SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
		errMsg, time.Now().UTC(), id,
	)
	return err
}

func marshalOperationResult(result interface{}) (string, error) {
	if result == nil {
		return "", nil
	}
	switch v := result.(type) {
	case string:
		return v, nil
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return "", fmt.Errorf("marshal operation result: %w", err)
		}
		return string(data), nil
	}
}

func listOperations(db *state.DB, includeAll bool) ([]operationRow, error) {
	query := `SELECT id, type, target_id, status, COALESCE(result, ''), COALESCE(error, ''), created_at, updated_at
	          FROM operations`
	var args []interface{}
	if !includeAll {
		query += ` WHERE status = 'running' OR updated_at >= datetime('now', '-5 minutes')`
	}
	query += ` ORDER BY created_at DESC`

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []operationRow
	for rows.Next() {
		var row operationRow
		if err := rows.Scan(&row.ID, &row.Type, &row.TargetID, &row.Status, &row.Result, &row.Error, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func renderSpinner(label string, done <-chan struct{}) {
	frames := []rune{'|', '/', '-', '\\'}
	i := 0
	for {
		select {
		case <-done:
			fmt.Printf("\r%s... done\n", label)
			return
		default:
			fmt.Printf("\r%s... %c", label, frames[i%len(frames)])
			time.Sleep(120 * time.Millisecond)
			i++
		}
	}
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
	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "sprint_start", active.ID)
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
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

	fmt.Printf("Starting sprint %s... (op %s)\n\n", short(active.ID), short(opID))
	fmt.Printf("sprint.started  sprint=%s operation=%s\n", short(active.ID), short(opID))
	results, err := executor.Run(active)

	// Stop signal handler after Run returns.
	signal.Stop(sigCh)

	if cancelled.Load() {
		_ = failOperation(db, opID, "cancelled")
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
		_ = failOperation(db, opID, err.Error())
		return fmt.Errorf("run sprint: %w", err)
	}

	var succeeded, failed int
	for _, r := range results {
		t, _ := planner.GetTask(r.TaskID)
		title := r.TaskID
		if t != nil {
			title = t.Title
		}
		fmt.Printf("sprint.progress task=%s status=%s duration=%s\n", short(r.TaskID), r.Status, r.Duration.Round(time.Second))
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
	if err := completeOperation(db, opID, map[string]interface{}{
		"sprint_id":  active.ID,
		"succeeded":  succeeded,
		"failed":     failed,
		"task_count": len(results),
	}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	fmt.Printf("sprint.completed sprint=%s operation=%s\n", short(active.ID), short(opID))

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
	repoDir, _ := os.Getwd()

	fmt.Printf("Sprint %s (%s)\n\n", short(active.ID), active.Status)
	for _, id := range active.TaskIDs {
		t, err := planner.GetTask(id)
		if err != nil {
			return fmt.Errorf("get task %s: %w", id, err)
		}
		line := fmt.Sprintf("  %s %s  %s", statusIcon(t.Status), short(t.ID), t.Title)
		if t.Status == "running" {
			if latest, err := tasklog.ReadLastLine(repoDir, t.ID); err == nil && latest != "" {
				line += "  |  " + latest
			}
		}
		fmt.Println(line)
	}
	return nil
}

func runSprintAssign(cmd *cobra.Command, args []string) error {
	db, _, planner, _, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	store := task.NewStore(db)
	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active == nil {
		active, err = planner.CreateEmpty()
		if err != nil {
			return fmt.Errorf("create sprint: %w", err)
		}
	}
	if active.Status != "planning" {
		return fmt.Errorf("sprint is running, cannot assign tasks")
	}

	var assigned int
	var lastAssignedID string
	for _, arg := range args {
		id, err := resolveTaskID(store, arg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			continue
		}
		if err := planner.AddTaskToSprint(active.ID, id); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			continue
		}
		assigned++
		lastAssignedID = id
	}

	if assigned == 1 {
		fmt.Printf("Assigned task %s to sprint %s (planning)\n", short(lastAssignedID), short(active.ID))
		return nil
	}
	if assigned > 1 {
		fmt.Printf("Assigned %d tasks to sprint %s (planning)\n", assigned, short(active.ID))
	}
	return nil
}

func runSprintUnassign(cmd *cobra.Command, args []string) error {
	db, _, planner, _, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	store := task.NewStore(db)
	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active == nil {
		return fmt.Errorf("no active sprint")
	}
	if active.Status != "planning" {
		return fmt.Errorf("sprint is running, cannot unassign tasks")
	}

	var removed int
	var lastRemovedID string
	for _, arg := range args {
		id, err := resolveTaskID(store, arg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			continue
		}
		if err := planner.RemoveTaskFromSprint(active.ID, id); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			continue
		}
		removed++
		lastRemovedID = id
	}

	if removed == 1 {
		fmt.Printf("Removed task %s from sprint %s\n", short(lastRemovedID), short(active.ID))
		return nil
	}
	if removed > 1 {
		fmt.Printf("Removed %d tasks from sprint %s\n", removed, short(active.ID))
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
	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "review", s.ID)
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
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

	fmt.Printf("\nRunning automated review... (op %s)\n", short(opID))
	fmt.Printf("review.started sprint=%s operation=%s\n", short(s.ID), short(opID))

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
		_ = failOperation(db, opID, err.Error())
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
			fmt.Printf("review.progress task=%s status=approved\n", short(r.TaskID))
			fmt.Printf("  \u2713 Approved: %s\n", title)
		} else {
			rejected++
			fmt.Printf("review.progress task=%s status=rejected\n", short(r.TaskID))
			fmt.Printf("  \u2717 Rejected: %s\n    feedback: %s\n", title, r.Feedback)
		}
	}
	if err := completeOperation(db, opID, map[string]interface{}{
		"sprint_id": s.ID,
		"approved":  approved,
		"rejected":  rejected,
	}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	fmt.Printf("review.completed sprint=%s operation=%s\n", short(s.ID), short(opID))
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
	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "integrate", sprintID)
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
	}
	fmt.Printf("integrate.started sprint=%s operation=%s\n", short(sprintID), short(opID))

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
		_ = failOperation(db, opID, err.Error())
		return fmt.Errorf("merge batch: %w", err)
	}

	for _, id := range merged {
		fmt.Printf("integrate.progress task=%s status=merged\n", short(id))
		if err := store.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
			fmt.Fprintf(os.Stderr, "warning: set task %s merged: %v\n", short(id), err)
		}
		fmt.Printf("  ✓ Merged task-%s\n", short(id))
	}
	for _, id := range failed {
		fmt.Printf("integrate.progress task=%s status=failed\n", short(id))
		fmt.Printf("  ✗ Failed task-%s\n", short(id))
	}
	if err := completeOperation(db, opID, map[string]interface{}{
		"sprint_id": sprintID,
		"merged":    merged,
		"failed":    failed,
	}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	fmt.Printf("integrate.completed sprint=%s operation=%s\n", short(sprintID), short(opID))
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
	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "cleanup", "")
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
	}
	fmt.Printf("cleanup.started operation=%s\n", short(opID))

	var removed int
	for _, s := range stale {
		if err := wm.Remove(s.taskID); err != nil {
			fmt.Fprintf(os.Stderr, "warning: remove %s: %v\n", s.branch, err)
			fmt.Printf("cleanup.progress branch=%s status=failed\n", s.branch)
			continue
		}
		removed++
		fmt.Printf("cleanup.progress branch=%s status=removed\n", s.branch)
	}
	if err := completeOperation(db, opID, map[string]interface{}{"removed": removed}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	fmt.Printf("cleanup.completed operation=%s removed=%d\n", short(opID), removed)

	fmt.Printf("\nRemoved %d worktrees\n", removed)
	return nil
}

func runOps(cmd *cobra.Command, args []string) error {
	db, _ := openStore()
	defer db.Close()

	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	includeAll, _ := cmd.Flags().GetBool("all")
	ops, err := listOperations(db, includeAll)
	if err != nil {
		return fmt.Errorf("list operations: %w", err)
	}
	if len(ops) == 0 {
		if includeAll {
			fmt.Println("No operations recorded.")
		} else {
			fmt.Println("No running/recent operations.")
		}
		return nil
	}

	for _, op := range ops {
		var elapsed time.Duration
		if op.Status == "running" {
			elapsed = time.Since(op.CreatedAt)
		} else {
			elapsed = op.UpdatedAt.Sub(op.CreatedAt)
		}
		if elapsed < 0 {
			elapsed = 0
		}

		target := op.TargetID
		if strings.TrimSpace(target) == "" {
			target = "-"
		} else {
			target = short(target)
		}

		fmt.Printf("%-8s %-14s target=%-8s elapsed=%-8s status=%s\n",
			short(op.ID), op.Type, target, elapsed.Round(time.Second), op.Status)
		if op.Error != "" {
			fmt.Printf("  error: %s\n", op.Error)
		}
	}
	return nil
}

// --- Log command ---

func runLogs(cmd *cobra.Command, args []string) error {
	follow, _ := cmd.Flags().GetBool("follow")
	tail, _ := cmd.Flags().GetInt("tail")
	listAll, _ := cmd.Flags().GetBool("all")

	repoDir, _ := os.Getwd()
	logsDir := filepath.Join(repoDir, ".pod", "logs")
	if err := tasklog.EnsureDir(repoDir); err != nil {
		return fmt.Errorf("ensure logs directory: %w", err)
	}

	db, store := openStore()
	defer db.Close()

	if listAll {
		entries, err := os.ReadDir(logsDir)
		if err != nil {
			if os.IsNotExist(err) {
				fmt.Println("No logs directory found.")
				return nil
			}
			return fmt.Errorf("list logs: %w", err)
		}
		type item struct {
			taskID  string
			status  string
			size    int64
			modTime time.Time
		}
		items := make([]item, 0, len(entries))
		for _, ent := range entries {
			if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".log") {
				continue
			}
			id := strings.TrimSuffix(ent.Name(), ".log")
			info, err := ent.Info()
			if err != nil {
				continue
			}
			status := "unknown"
			if tk, err := store.Get(id); err == nil {
				status = tk.Status
			}
			items = append(items, item{
				taskID:  id,
				status:  status,
				size:    info.Size(),
				modTime: info.ModTime(),
			})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].modTime.After(items[j].modTime) })
		if len(items) == 0 {
			fmt.Println("No task logs found.")
			return nil
		}
		for _, it := range items {
			fmt.Printf("%s  status=%s  size=%dB\n", short(it.taskID), it.status, it.size)
		}
		return nil
	}

	if len(args) != 1 {
		return fmt.Errorf("task-id is required unless --all is set")
	}

	taskID, err := resolveTaskID(store, args[0])
	if err != nil {
		if strings.HasPrefix(err.Error(), "task not found") {
			taskID = args[0]
		} else {
			return err
		}
	}
	logPath := tasklog.Path(repoDir, taskID)
	if _, err := os.Stat(logPath); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("log not found for task %s", args[0])
		}
		return fmt.Errorf("stat log: %w", err)
	}

	var lines []string
	if tail > 0 {
		lines, err = tasklog.ReadTailLines(repoDir, taskID, tail)
	} else {
		lines, err = tasklog.ReadLines(repoDir, taskID)
	}
	if err != nil {
		return fmt.Errorf("read log: %w", err)
	}
	for _, line := range lines {
		fmt.Println(line)
	}
	if !follow {
		return nil
	}

	return followTaskLog(logPath)
}

func followTaskLog(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	offset, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	var carry string

	for {
		time.Sleep(250 * time.Millisecond)

		st, err := os.Stat(path)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if st.Size() < offset {
			offset = 0
			carry = ""
		}
		if st.Size() == offset {
			continue
		}
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return err
		}
		chunk, err := io.ReadAll(f)
		if err != nil {
			return err
		}
		offset = st.Size()
		text := carry + strings.ToValidUTF8(string(chunk), "?")
		parts := strings.Split(text, "\n")
		carry = parts[len(parts)-1]
		for _, line := range parts[:len(parts)-1] {
			fmt.Println(line)
		}
	}
}

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

// --- Serve command ---

func runServe(cmd *cobra.Command, args []string) error {
	db, cfg, planner, executor, err := loadRuntime()
	if err != nil {
		return err
	}
	defer db.Close()

	repoDir, _ := os.Getwd()
	addr, _ := cmd.Flags().GetString("addr")

	// Embed frontend static files from web/dist.
	var frontendFS fs.FS
	if sub, err := fs.Sub(web.DistFS, "dist"); err == nil {
		frontendFS = sub
	}

	srv := api.NewServer(db, cfg, planner, executor, repoDir, frontendFS)

	fmt.Printf("Pod server listening on %s\n", addr)
	return http.ListenAndServe(addr, srv.Routes())
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

func runAutopilotRespond(cmd *cobra.Command, args []string) error {
	baseURL, _ := cmd.Flags().GetString("addr")
	cont, _ := cmd.Flags().GetBool("continue")

	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return fmt.Errorf("addr is required")
	}
	payload := map[string]bool{"continue": cont}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	resp, err := http.Post(baseURL+"/api/v1/autopilot/respond", "application/json", bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("post autopilot respond: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(body))
		if msg == "" {
			msg = resp.Status
		}
		return fmt.Errorf("autopilot respond failed: %s", msg)
	}

	fmt.Printf("Sent autopilot response: continue=%t\n", cont)
	return nil
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
