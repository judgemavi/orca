package commands

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/banner"
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

	logsCmd := &cobra.Command{Use: "logs", Short: "Show application logs", RunE: r.runLogs}
	logsCmd.Flags().String("level", "", "Filter by level: debug|info|warn|error")
	logsCmd.Flags().String("task", "", "Filter by task ID")
	logsCmd.Flags().String("sprint", "", "Filter by sprint ID")
	logsCmd.Flags().String("since", "", "Show logs since duration ago (e.g. 30m, 2h)")
	logsCmd.Flags().Int("tail", 50, "Show last N matching lines")
	logsCmd.Flags().BoolP("follow", "f", false, "Stream new matching lines")
	logsCmd.Flags().Bool("json", false, "Output as JSON lines")
	if opts.MarkSkipRuntimeInit != nil {
		opts.MarkSkipRuntimeInit(logsCmd)
	}
	root.AddCommand(logsCmd)

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
	root.AddCommand(configCmd)

	root.AddCommand(&cobra.Command{Use: "orc", Short: "Launch orchestrator in current terminal", RunE: r.runOrc})
}

func (r *Registry) runInit(cmd *cobra.Command, args []string) error {
	banner.Print()
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}
	yes, _ := cmd.Flags().GetBool("yes")
	orcaDir := filepath.Join(cwd, ".orca")

	// --- Pre-flight: reinit check + load existing config ---
	var existingCfg *config.Config
	if _, err := os.Stat(orcaDir); err == nil {
		fmt.Println("Orca already initialized. Run 'orca config' to view settings.")
		reinit := yes
		if !yes {
			if err := huh.NewConfirm().Title("Reinitialize?").Description("Existing config will be used as defaults.").Affirmative("Yes").Negative("No").Value(&reinit).Run(); err != nil {
				return err
			}
		}
		if !reinit {
			return nil
		}
		cfgPath := filepath.Join(orcaDir, "orca.yaml")
		if loaded, loadErr := config.Load(cfgPath); loadErr == nil {
			existingCfg = loaded
		}
	}

	// --- Pre-flight: git repo ---
	if _, err := os.Stat(filepath.Join(cwd, ".git")); os.IsNotExist(err) {
		initRepo := yes
		if !yes {
			if err := huh.NewConfirm().Title("No git repository found").Description("Orca requires a git repo. Initialize one?").Affirmative("Yes").Negative("No").Value(&initRepo).Run(); err != nil {
				return err
			}
		}
		if !initRepo {
			return fmt.Errorf("orca init requires a git repository")
		}
		gitInit := exec.Command("git", "init")
		gitInit.Dir = cwd
		if err := gitInit.Run(); err != nil {
			return fmt.Errorf("git init: %w", err)
		}
	}

	// --- Pre-flight: ensure at least one commit ---
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

	// --- Detect tools ---
	fmt.Println("Detecting tools...")
	detected := detectTools()
	if len(detected) == 0 {
		return fmt.Errorf("no supported tools found on PATH (need at least one of: claude, codex, aider)")
	}
	for _, name := range []string{"claude", "codex", "aider"} {
		found := false
		for _, d := range detected {
			if d == name {
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

	// --- Tool selection ---
	available := detected
	if !yes && len(detected) > 1 {
		toolOpts := make([]huh.Option[string], len(detected))
		for i, name := range detected {
			preSelected := true
			if existingCfg != nil {
				// Only pre-select tools that were previously enabled
				_, preSelected = existingCfg.Tools[name]
			}
			toolOpts[i] = huh.NewOption(name, name).Selected(preSelected)
		}
		var selected []string
		if err := huh.NewMultiSelect[string]().Title("Enable tools").Options(toolOpts...).Value(&selected).Run(); err != nil {
			return err
		}
		if len(selected) == 0 {
			return fmt.Errorf("at least one tool must be enabled")
		}
		available = selected
	}

	// --- Load defaults for config building ---
	cfg, err := config.Default()
	if err != nil {
		return fmt.Errorf("load default config: %w", err)
	}

	// --- Build model options per tool ---
	type toolModelInfo struct {
		name   string
		models []string
	}
	var toolModels []toolModelInfo
	for _, name := range available {
		if tc, ok := cfg.Tools[name]; ok {
			ms := model.FromConfig(name, tc)
			ids := make([]string, len(ms))
			for i, m := range ms {
				ids[i] = m.ID
			}
			toolModels = append(toolModels, toolModelInfo{name: name, models: ids})
		}
	}

	// --- Interactive form defaults (seeded from existing config if reinitializing) ---
	projectName := filepath.Base(cwd)
	integrationBranch := "orca/integration"
	maxParallelStr := "3"
	defaultTool := available[0]
	supervisorTool := available[0]
	supervisorModel := ""
	costBudget := "0"
	validationCmd := ""
	qualityScopeCheck := true
	qualityTestDelta := true
	qualityAlignment := false

	if existingCfg != nil {
		if existingCfg.Project.Name != "" {
			projectName = existingCfg.Project.Name
		}
		if existingCfg.Project.IntegrationBranch != "" {
			integrationBranch = existingCfg.Project.IntegrationBranch
		}
		if existingCfg.Workers.MaxParallel > 0 {
			maxParallelStr = strconv.Itoa(existingCfg.Workers.MaxParallel)
		}
		if existingCfg.Defaults.Tool != "" && containsTool(available, existingCfg.Defaults.Tool) {
			defaultTool = existingCfg.Defaults.Tool
		}
		if existingCfg.Orchestrator.SupervisorTool != "" && containsTool(available, existingCfg.Orchestrator.SupervisorTool) {
			supervisorTool = existingCfg.Orchestrator.SupervisorTool
		}
		supervisorModel = existingCfg.Orchestrator.SupervisorModel
		costBudget = strconv.FormatFloat(existingCfg.Orchestrator.CostBudget, 'f', -1, 64)
		if len(existingCfg.Validation.Commands) > 0 {
			validationCmd = existingCfg.Validation.Commands[0]
		}
		qualityScopeCheck = existingCfg.Quality.ScopeCheck
		qualityTestDelta = existingCfg.Quality.TestDelta
		qualityAlignment = existingCfg.Quality.AlignmentCheck
	}

	if !yes {
		// Default tool select options
		defaultToolOpts := make([]huh.Option[string], len(available))
		for i, name := range available {
			defaultToolOpts[i] = huh.NewOption(name, name)
		}

		// Model select fields per tool — use slice of pointers so huh can bind
		type modelBinding struct {
			name  string
			value string
		}
		modelBindings := make([]*modelBinding, 0, len(toolModels))
		var modelFields []huh.Field
		for _, tm := range toolModels {
			if len(tm.models) == 0 {
				continue
			}
			defaultModel := tm.models[0]
			if existingCfg != nil {
				if tc, ok := existingCfg.Tools[tm.name]; ok && tc.Model != "" {
					defaultModel = tc.Model
				}
			}
			mb := &modelBinding{name: tm.name, value: defaultModel}
			modelBindings = append(modelBindings, mb)
			opts := make([]huh.Option[string], len(tm.models))
			for i, m := range tm.models {
				opts[i] = huh.NewOption(m, m)
			}
			modelFields = append(modelFields, huh.NewSelect[string]().
				Title(fmt.Sprintf("Default model for %s", tm.name)).
				Options(opts...).
				Value(&mb.value))
		}

		// Quality gate options
		qualityOpts := []huh.Option[string]{
			huh.NewOption("Scope check", "scope").Selected(qualityScopeCheck),
			huh.NewOption("Test delta", "test").Selected(qualityTestDelta),
			huh.NewOption("LLM alignment check", "alignment").Selected(qualityAlignment),
		}
		var qualitySelected []string

		// Build form groups
		groups := []*huh.Group{
			huh.NewGroup(
				huh.NewInput().Title("Project name").Value(&projectName),
				huh.NewInput().Title("Integration branch").Value(&integrationBranch),
				huh.NewSelect[string]().Title("Default tool").Options(defaultToolOpts...).Value(&defaultTool),
				huh.NewInput().Title("Max parallel workers").Value(&maxParallelStr).
					Validate(func(v string) error {
						n, err := strconv.Atoi(v)
						if err != nil || n < 1 {
							return fmt.Errorf("must be a positive integer")
						}
						return nil
					}),
			),
		}

		if len(modelFields) > 0 {
			groups = append(groups, huh.NewGroup(modelFields...))
		}

		groups = append(groups,
			huh.NewGroup(
				huh.NewInput().Title("Validation command").Description("Test command to run after integration (leave empty to skip)").Placeholder("e.g. go test ./...").Value(&validationCmd),
				huh.NewInput().Title("Cost budget (USD)").Description("0 = unlimited").Value(&costBudget),
				huh.NewMultiSelect[string]().Title("Quality gates").Options(qualityOpts...).Value(&qualitySelected),
			),
		)

		form := huh.NewForm(groups...)
		if err := form.Run(); err != nil {
			return err
		}

		// Orchestrator: tool then model (sequential so model is filtered)
		supervisorToolOpts := make([]huh.Option[string], len(available))
		for i, name := range available {
			supervisorToolOpts[i] = huh.NewOption(name, name)
		}
		if err := huh.NewSelect[string]().
			Title("Orchestrator tool").
			Description("CLI tool that drives orca orc (autopilot)").
			Options(supervisorToolOpts...).
			Value(&supervisorTool).
			Run(); err != nil {
			return err
		}

		for _, tm := range toolModels {
			if tm.name == supervisorTool && len(tm.models) > 0 {
				modelOpts := []huh.Option[string]{huh.NewOption("(tool default)", "")}
				for _, m := range tm.models {
					modelOpts = append(modelOpts, huh.NewOption(m, m))
				}
				if err := huh.NewSelect[string]().
					Title("Orchestrator model").
					Description(fmt.Sprintf("Model for %s supervisor agent", supervisorTool)).
					Options(modelOpts...).
					Value(&supervisorModel).
					Run(); err != nil {
					return err
				}
				break
			}
		}

		// Per-phase tool/model config
		phases := []string{"explore", "plan", "sprint", "review", "integrate"}
		phaseToolSelections := make(map[string]string, len(phases))

		// Seed from existing config
		for _, phase := range phases {
			phaseToolSelections[phase] = ""
			if existingCfg != nil {
				if pc, ok := existingCfg.Orchestrator.Phases[phase]; ok && pc.Tool != "" {
					phaseToolSelections[phase] = pc.Tool
				}
			}
		}

		// Build phase tool selects
		type phaseToolBinding struct {
			phase string
			value string
		}
		phaseBindings := make([]*phaseToolBinding, len(phases))
		var phaseFields []huh.Field
		for i, phase := range phases {
			pb := &phaseToolBinding{phase: phase, value: phaseToolSelections[phase]}
			phaseBindings[i] = pb
			opts := []huh.Option[string]{huh.NewOption(fmt.Sprintf("(default: %s)", defaultTool), "")}
			for _, name := range available {
				opts = append(opts, huh.NewOption(name, name))
			}
			phaseFields = append(phaseFields, huh.NewSelect[string]().
				Title(fmt.Sprintf("%s phase tool", phase)).
				Options(opts...).
				Value(&pb.value))
		}
		if err := huh.NewForm(huh.NewGroup(phaseFields...)).Run(); err != nil {
			return err
		}

		// For phases with an overridden tool, ask for model
		phaseModelSelections := make(map[string]string, len(phases))
		for _, pb := range phaseBindings {
			if pb.value == "" {
				continue
			}
			// Seed from existing config
			phaseModelSelections[pb.phase] = ""
			if existingCfg != nil {
				if pc, ok := existingCfg.Orchestrator.Phases[pb.phase]; ok {
					phaseModelSelections[pb.phase] = pc.Model
				}
			}

			for _, tm := range toolModels {
				if tm.name == pb.value && len(tm.models) > 0 {
					modelVal := phaseModelSelections[pb.phase]
					modelOpts := []huh.Option[string]{huh.NewOption("(tool default)", "")}
					for _, m := range tm.models {
						modelOpts = append(modelOpts, huh.NewOption(m, m))
					}
					if err := huh.NewSelect[string]().
						Title(fmt.Sprintf("%s phase model", pb.phase)).
						Description(fmt.Sprintf("Model for %s using %s", pb.phase, pb.value)).
						Options(modelOpts...).
						Value(&modelVal).
						Run(); err != nil {
						return err
					}
					phaseModelSelections[pb.phase] = modelVal
					break
				}
			}
		}

		// Parse quality selections
		qualityScopeCheck = false
		qualityTestDelta = false
		qualityAlignment = false
		for _, v := range qualitySelected {
			switch v {
			case "scope":
				qualityScopeCheck = true
			case "test":
				qualityTestDelta = true
			case "alignment":
				qualityAlignment = true
			}
		}

		// Apply model selections
		for _, mb := range modelBindings {
			if tc, ok := cfg.Tools[mb.name]; ok {
				tc.Model = mb.value
				cfg.Tools[mb.name] = tc
			}
		}

		// Apply phase overrides
		phaseConfigs := make(map[string]config.PhaseConfig)
		for _, pb := range phaseBindings {
			if pb.value == "" {
				continue
			}
			phaseConfigs[pb.phase] = config.PhaseConfig{
				Tool:  pb.value,
				Model: phaseModelSelections[pb.phase],
			}
		}
		if len(phaseConfigs) > 0 {
			cfg.Orchestrator.Phases = phaseConfigs
		}
	}

	// --- Apply config ---
	maxParallel, _ := strconv.Atoi(maxParallelStr)
	if maxParallel < 1 {
		maxParallel = 3
	}

	cfg.Project.Name = projectName
	cfg.Project.IntegrationBranch = integrationBranch
	cfg.Workers.MaxParallel = maxParallel
	cfg.Defaults.Tool = defaultTool
	cfg.Orchestrator.SupervisorTool = supervisorTool
	cfg.Orchestrator.SupervisorModel = supervisorModel

	budget, _ := strconv.ParseFloat(costBudget, 64)
	cfg.Orchestrator.CostBudget = budget

	if validationCmd != "" {
		cfg.Validation.Commands = []string{validationCmd}
	}

	cfg.Quality.Enabled = qualityScopeCheck || qualityTestDelta || qualityAlignment
	cfg.Quality.ScopeCheck = qualityScopeCheck
	cfg.Quality.TestDelta = qualityTestDelta
	cfg.Quality.AlignmentCheck = qualityAlignment

	enabledTools := make(map[string]config.ToolConfig)
	for _, name := range available {
		if tc, ok := cfg.Tools[name]; ok {
			enabledTools[name] = tc
		}
	}
	if len(enabledTools) == 0 {
		return fmt.Errorf("none of the selected tools are present in config defaults")
	}
	cfg.Tools = enabledTools

	// --- Write config + DB ---
	if err := os.MkdirAll(orcaDir, 0755); err != nil {
		return fmt.Errorf("create .orca directory: %w", err)
	}
	cfgPath := filepath.Join(orcaDir, "orca.yaml")
	dbPath := filepath.Join(orcaDir, "state.db")

	if err := cfg.SaveAnnotated(cfgPath); err != nil {
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

	fmt.Printf("\n✓ Orca initialized in %s\n\n", cwd)
	fmt.Println("Getting started:")
	fmt.Println("  orca explore                      Analyze codebase for context")
	fmt.Println("  orca backlog add \"task title\"     Add tasks to the backlog")
	fmt.Println("  orca backlog list                  View all tasks")
	fmt.Println("  orca breakdown \"goal\"             Break down a goal into tasks")
	fmt.Println("  orca sprint plan                  Select tasks for a sprint")
	fmt.Println("  orca sprint start                 Execute the sprint")
	fmt.Println("  orca sprint review                Review completed work")
	fmt.Println("  orca integrate                    Merge approved tasks")
	fmt.Println("  orca run                          Do all of the above in one shot")
	fmt.Println("  orca status                       Show project overview")
	fmt.Println("  orca serve                        Open web UI")
	fmt.Println("  orca orc                          Launch orchestrator (autopilot)")
	return nil
}

func containsTool(tools []string, name string) bool {
	for _, t := range tools {
		if t == name {
			return true
		}
	}
	return false
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

func ensureOrcaIgnored(cwd string) error {
	gitignorePath := filepath.Join(cwd, ".gitignore")
	existing, err := os.ReadFile(gitignorePath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read .gitignore: %w", err)
	}

	entries := []string{".orca/worktrees/", ".orca/*.db", ".orca/*.db-wal", ".orca/*.db-shm"}
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

	confirm := false
	if err := huh.NewConfirm().
		Title(fmt.Sprintf("Remove %d stale worktrees?", len(stale))).
		Affirmative("Yes").
		Negative("No").
		Value(&confirm).Run(); err != nil {
		return err
	}
	if !confirm {
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

	mcpConfigPath, err := orchestrator.WriteMCPConfig(repoDir, orcaBinary, cfg.Tools)
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
