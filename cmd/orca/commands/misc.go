package commands

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/cost"
	"github.com/jasjeetmavi/orca/internal/model"
	"github.com/jasjeetmavi/orca/internal/orchestrator"
	"github.com/jasjeetmavi/orca/internal/sprint"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

type MiscOptions struct {
	MarkSkipRuntimeInit func(*cobra.Command)
}

func RegisterMisc(root *cobra.Command, r *Registry, opts MiscOptions) {
	initCmd := &cobra.Command{Use: "init", Short: "Initialize Orca in current git repo", RunE: r.runInit}
	if opts.MarkSkipRuntimeInit != nil {
		opts.MarkSkipRuntimeInit(initCmd)
	}
	initCmd.Flags().BoolP("yes", "y", false, "Accept defaults and skip prompts")
	root.AddCommand(initCmd)

	modelsCmd := &cobra.Command{Use: "models [tool]", Short: "List available models for configured tools", Args: cobra.MaximumNArgs(1), RunE: r.runModels}
	if opts.MarkSkipRuntimeInit != nil {
		opts.MarkSkipRuntimeInit(modelsCmd)
	}
	root.AddCommand(modelsCmd)

	cleanupCmd := &cobra.Command{Use: "cleanup", Short: "Remove stale worktrees", RunE: r.runCleanup}
	cleanupCmd.Flags().Bool("dry-run", false, "Show what would be removed without removing")
	root.AddCommand(cleanupCmd)

	logCmd := &cobra.Command{Use: "log", Short: "Show sprint history", RunE: r.runLog}
	logCmd.Flags().Bool("all", false, "Show all sprints (default: last 10)")
	root.AddCommand(logCmd)

	root.AddCommand(&cobra.Command{Use: "status", Short: "Show overall project status", RunE: r.runStatus})

	costsCmd := &cobra.Command{Use: "costs", Short: "Show cost tracking summary", RunE: r.runCosts}
	costsCmd.Flags().String("sprint", "", "Show costs for specific sprint (prefix ID)")
	root.AddCommand(costsCmd)

	opsCmd := &cobra.Command{Use: "ops", Short: "List tracked operations", RunE: r.runOps}
	opsCmd.Flags().Bool("all", false, "Include historical completed/failed operations")
	root.AddCommand(opsCmd)

	configCmd := &cobra.Command{
		Use:   "config",
		Short: "Manage orca configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	configShowCmd := &cobra.Command{Use: "show", Short: "Print current configuration", RunE: r.runConfigShow}
	if opts.MarkSkipRuntimeInit != nil {
		opts.MarkSkipRuntimeInit(configShowCmd)
	}
	configCmd.AddCommand(configShowCmd)
	configCmd.AddCommand(&cobra.Command{Use: "set [key] [value]", Short: "Set a config value (e.g., orchestrator.cost_budget 10.0)", Args: cobra.ExactArgs(2), RunE: r.runConfigSet})
	root.AddCommand(configCmd)

	root.AddCommand(&cobra.Command{Use: "orc", Short: "Launch orchestrator in current terminal", RunE: r.runOrc})
}

func (r *Registry) runInit(cmd *cobra.Command, args []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}
	yes, _ := cmd.Flags().GetBool("yes")
	scanner := bufio.NewScanner(os.Stdin)
	orcaDir := filepath.Join(cwd, ".orca")

	if _, err := os.Stat(orcaDir); err == nil {
		fmt.Println("Orca already initialized. Run 'orca config' to view settings.")
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
			return fmt.Errorf("orca init requires a git repository")
		}
		initCmd := exec.Command("git", "init")
		initCmd.Dir = cwd
		if err := initCmd.Run(); err != nil {
			return fmt.Errorf("git init: %w", err)
		}
	}

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
	integrationBranchDefault := "orca/integration"
	maxParallelDefault := 2

	projectName, err := promptString(scanner, yes, fmt.Sprintf("Project name [%s]: ", projectNameDefault), projectNameDefault)
	if err != nil {
		return err
	}
	integrationBranch, err := promptString(scanner, yes, fmt.Sprintf("Integration branch [%s]: ", integrationBranchDefault), integrationBranchDefault)
	if err != nil {
		return err
	}

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

	if err := os.MkdirAll(orcaDir, 0755); err != nil {
		return fmt.Errorf("create .orca directory: %w", err)
	}

	cfgPath := filepath.Join(orcaDir, "orca.yaml")
	dbPath := filepath.Join(orcaDir, "state.db")

	cfg, err := config.Default()
	if err != nil {
		return fmt.Errorf("load default config: %w", err)
	}
	cfg.Project.Name = projectName
	cfg.Project.IntegrationBranch = integrationBranch
	cfg.Workers.MaxParallel = maxParallel

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

	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		db, err := state.Open(dbPath)
		if err != nil {
			return fmt.Errorf("create database: %w", err)
		}
		db.Close()
	}

	branchCmd := exec.Command("git", "branch", integrationBranch)
	branchCmd.Dir = cwd
	if err := branchCmd.Run(); err != nil {
		checkCmd := exec.Command("git", "rev-parse", "--verify", integrationBranch)
		checkCmd.Dir = cwd
		if checkCmd.Run() != nil {
			return fmt.Errorf("failed to create integration branch: %w", err)
		}
	}

	if err := ensureOrcaIgnored(cwd); err != nil {
		return err
	}

	fmt.Printf("✓ Orca initialized in %s\n\n", cwd)
	fmt.Println("Getting started:")
	fmt.Println("  orca backlog add \"task title\"     Add tasks to the backlog")
	fmt.Println("  orca backlog                      View all tasks")
	fmt.Println("  orca backlog edit <id> --tool codex  Assign a tool")
	fmt.Println("  orca sprint plan                  Plan a sprint from ready tasks")
	fmt.Println("  orca sprint assign <id>           Manually add task to sprint")
	fmt.Println("  orca start                        Execute the sprint")
	fmt.Println("  orca review                       Review completed work")
	fmt.Println("  orca integrate                    Merge into integration branch")
	fmt.Println("  orca serve                        Open web UI at localhost:8080")
	fmt.Println()
	fmt.Println("Tip: Run 'orca explore' to analyze your codebase before planning.")
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

func ensureOrcaIgnored(cwd string) error {
	gitignorePath := filepath.Join(cwd, ".gitignore")
	existing, err := os.ReadFile(gitignorePath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read .gitignore: %w", err)
	}

	entries := []string{".orca/worktrees/", ".orca/*.db-wal", ".orca/*.db-shm"}
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
	if _, err := f.WriteString("# Orca orchestrator\n"); err != nil {
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

func (r *Registry) runModels(cmd *cobra.Command, args []string) error {
	cfgPath := filepath.Join(".orca", "orca.yaml")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("orca not initialized — run 'orca init' first")
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

func (r *Registry) runCleanup(cmd *cobra.Command, args []string) error {
	db, _, _, executor, err := r.loadRuntimeOrErr()
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
		if wt.Branch == "main" || wt.Branch == "master" || wt.Branch == "" {
			if wt.Branch == "" {
				fmt.Fprintf(os.Stderr, "warning: skipping worktree with no branch: %s\n", wt.Path)
			}
			continue
		}
		if wt.Branch == "orca/integration" || !strings.HasPrefix(wt.Branch, "orca/task-") {
			continue
		}

		taskID := strings.TrimPrefix(wt.Branch, "orca/task-")
		t, err := store.Get(taskID)
		if err != nil {
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

func (r *Registry) runOps(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
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

		fmt.Printf("%-8s %-14s target=%-8s elapsed=%-8s status=%s\n", short(op.ID), op.Type, target, elapsed.Round(time.Second), op.Status)
		if op.Error != "" {
			fmt.Printf("  error: %s\n", op.Error)
		}
	}
	return nil
}

func (r *Registry) runLog(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
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
		var sr sprintRow
		if err := rows.Scan(&sr.id, &sr.status, &sr.createdAt, &sr.completedAt); err != nil {
			return fmt.Errorf("scan sprint: %w", err)
		}
		sprints = append(sprints, sr)
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

func (r *Registry) runOrc(cmd *cobra.Command, args []string) error {
	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	orcaBinary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve orca binary: %w", err)
	}

	_, cfg, _, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}

	mcpConfigPath, err := orchestrator.WriteMCPConfig(repoDir, orcaBinary)
	if err != nil {
		return fmt.Errorf("write mcp config: %w", err)
	}

	_, toolCfg, err := orchestrator.ResolveSupervisorTool(cfg)
	if err != nil {
		return fmt.Errorf("resolve supervisor tool: %w", err)
	}

	launchArgs := orchestrator.BuildLaunchArgs(toolCfg, mcpConfigPath)
	c := exec.Command(toolCfg.Binary, launchArgs...)
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	c.Env = append(os.Environ(), "ORCA_MCP_CONFIG="+mcpConfigPath)
	return c.Run()
}

func (r *Registry) runConfigShow(cmd *cobra.Command, args []string) error {
	cfgPath := filepath.Join(".orca", "orca.yaml")
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

func (r *Registry) runConfigSet(cmd *cobra.Command, args []string) error {
	cfgPath := filepath.Join(".orca", "orca.yaml")
	_, cfg, _, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}

	key, value := args[0], args[1]
	switch key {
	case "orchestrator.cost_budget":
		f, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return fmt.Errorf("invalid float %q: %w", value, err)
		}
		cfg.Orchestrator.CostBudget = f
	case "orchestrator.supervisor_tool":
		cfg.Orchestrator.SupervisorTool = value
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

func (r *Registry) runCosts(cmd *cobra.Command, args []string) error {
	db, cfg, _, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	ct := cost.NewTracker(db)
	sprintFlag, _ := cmd.Flags().GetString("sprint")

	if sprintFlag != "" {
		var sprintID string
		err := db.QueryRow(`SELECT id FROM sprints WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1`, sprintFlag+"%").Scan(&sprintID)
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
			fmt.Printf("  %-10s $%.2f  (%s in / %s out tokens)\n", s.Tool+":", s.Cost, formatTokens(s.InputTokens), formatTokens(s.OutputTokens))
		}
		return nil
	}

	projectTotal, _ := ct.ProjectTotal()
	if projectTotal == 0 {
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
			fmt.Printf("  %-10s $%.2f  (%s in / %s out tokens)\n", s.Tool+":", s.Cost, formatTokens(s.InputTokens), formatTokens(s.OutputTokens))
		}
	}

	rows, err := db.Query(`SELECT s.id, COALESCE(SUM(c.estimated_cost), 0), COUNT(DISTINCT c.task_id)
		 FROM sprints s
		 LEFT JOIN costs c ON c.sprint_id = s.id
		 GROUP BY s.id
		 ORDER BY s.created_at DESC
		 LIMIT 10`)
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

	budget := cfg.Orchestrator.CostBudget
	if budget > 0 {
		remaining, _ := ct.BudgetRemaining(budget)
		fmt.Printf("\nBudget: $%.2f  remaining: $%.2f\n", budget, remaining)
	} else {
		fmt.Println("\nBudget: unlimited")
	}

	return nil
}

func (r *Registry) runStatus(cmd *cobra.Command, args []string) error {
	db, cfg, _, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	store := task.NewStore(db)
	defer db.Close()

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

	fmt.Printf("Orca status: %s\n\n", cfg.Project.Name)
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
