package commands

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/banner"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/spf13/cobra"
)

type toolModelInfo struct {
	name   string
	models []string
}

func newInitCmd(r *Registry, opts MiscOptions) *cobra.Command {
	initCmd := &cobra.Command{Use: "init", Short: "Initialize Orca in current git repo", RunE: r.runInit}
	if opts.MarkSkipRuntimeInit != nil {
		opts.MarkSkipRuntimeInit(initCmd)
	}
	initCmd.Flags().BoolP("yes", "y", false, "Accept defaults and skip prompts")
	return initCmd
}

func (r *Registry) runInit(cmd *cobra.Command, args []string) error {
	banner.Print()
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}
	yes, _ := cmd.Flags().GetBool("yes")

	existingCfg, proceed, err := runInitPreflight(cwd, yes)
	if err != nil {
		return err
	}
	if !proceed {
		return nil
	}

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

	cfg, integrationBranch, err := runInteractiveConfig(cwd, yes, existingCfg, detected)
	if err != nil {
		return err
	}

	if err := serializeConfig(cwd, &cfg, integrationBranch); err != nil {
		return err
	}

	if err := runInitAutoExplore(cwd, &cfg); err != nil {
		warnf("initial explore failed: %v", err)
		fmt.Println("Init will continue. You can run `orca explore` later.")
	}

	fmt.Printf("\n✓ Orca initialized in %s\n\n", cwd)
	fmt.Println("Getting started:")
	fmt.Println("  orca explore                      Analyze codebase for context")
	fmt.Println("  orca tasks add \"task title\"        Add a task")
	fmt.Println("  orca tasks list                     View all tasks")
	fmt.Println("  orca breakdown \"goal\"             Break down a goal into tasks")
	fmt.Println("  orca start                        Start ready tasks")
	fmt.Println("  orca review approve <task-id>     Approve reviewed work")
	fmt.Println("  orca merge                        Merge approved tasks")
	fmt.Println("  orca status                       Show project overview")
	fmt.Println("  orca serve                        Open web UI")
	fmt.Println("  orca orc                          Launch orchestrator (autopilot)")
	return nil
}

func runInitAutoExplore(repoDir string, cfg *config.Config) error {
	if cfg == nil {
		fmt.Println("Skipping initial exploration (no config available).")
		return nil
	}
	toolName, tool, err := cfg.ResolveToolForPhase(interaction.PhaseExplore, "")
	if err != nil {
		fmt.Printf("Skipping initial exploration: %v\n", err)
		return nil
	}
	model := cfg.ResolveModelForPhase(interaction.PhaseExplore, "", toolName)

	hasTrackedCode, err := explore.HasTrackedCode(repoDir)
	if err != nil {
		return fmt.Errorf("inspect tracked files: %w", err)
	}
	if !hasTrackedCode {
		fmt.Printf("Skipping initial exploration: %s\n", explore.NoTrackedCodeMessage)
		return nil
	}

	dbPath := filepath.Join(repoDir, ".orca", "state.db")
	db, err := state.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open state db for init explore: %w", err)
	}
	defer db.Close()

	memoryStore := memory.NewStore(db)
	beforeSeeded, _ := memoryStore.List(memory.ListOpts{Tag: "explore-seed"})

	fmt.Println("Running initial codebase exploration...")
	explorer := explore.New(toolName, tool, model, 10*time.Minute, repoDir, interaction.NewStore(db, ".orca/interactions")).
		WithMemory(memoryStore).
		WithSyncer(newConfiguredMemorySyncer(cfg, memoryStore, db, repoDir))

	outPath, err := explorer.Run()
	if err != nil {
		return fmt.Errorf("auto explore: %w", err)
	}
	setInitSyncBaseline(cfg, memoryStore, db, repoDir)

	contextSize := len(strings.TrimSpace(explore.LoadContext(repoDir)))
	afterSeeded, _ := memoryStore.List(memory.ListOpts{Tag: "explore-seed"})
	seededDelta := len(afterSeeded) - len(beforeSeeded)
	if seededDelta < 0 {
		seededDelta = 0
	}

	fmt.Printf("Initial exploration complete: context=%d bytes, memory seeded=%d, stored=%s\n", contextSize, seededDelta, outPath)
	return nil
}

func setInitSyncBaseline(cfg *config.Config, memoryStore *memory.Store, db *state.DB, repoDir string) {
	if cfg == nil || memoryStore == nil || db == nil {
		return
	}
	syncer := newConfiguredMemorySyncer(cfg, memoryStore, db, repoDir)
	if syncer == nil {
		return
	}
	head, err := gitHeadSHA(repoDir)
	if err != nil || head == "" {
		return
	}
	_ = syncer.SetLastSyncedCommit(head)
}

func gitHeadSHA(repoDir string) (string, error) {
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git rev-parse HEAD: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

func runInitPreflight(cwd string, yes bool) (*config.Config, bool, error) {
	orcaDir := filepath.Join(cwd, ".orca")
	dbPath := filepath.Join(orcaDir, "state.db")

	var existingCfg *config.Config
	if loaded, loadErr := loadConfigFromDBPath(dbPath); loadErr == nil && loaded != nil {
		existingCfg = loaded
		fmt.Println("Orca already initialized. Run 'orca config' to view settings.")
		reinit := yes
		if !yes {
			if err := huh.NewConfirm().Title("Reinitialize?").Description("Existing config will be used as defaults.").Affirmative("Yes").Negative("No").Value(&reinit).Run(); err != nil {
				return nil, false, err
			}
		}
		if !reinit {
			return nil, false, nil
		}
	}

	if _, err := os.Stat(filepath.Join(cwd, ".git")); os.IsNotExist(err) {
		fmt.Println("Initializing git repository...")
		gitInit := exec.Command("git", "init")
		gitInit.Dir = cwd
		if err := gitInit.Run(); err != nil {
			return nil, false, fmt.Errorf("git init: %w", err)
		}
	}

	headCheck := exec.Command("git", "rev-parse", "HEAD")
	headCheck.Dir = cwd
	if err := headCheck.Run(); err != nil {
		fmt.Println("Git repo has no commits. Creating initial commit...")
		// Ensure .orca/ is gitignored BEFORE staging so `git add -A`
		// doesn't pick up orca.log or other runtime files.
		if err := ensureOrcaIgnored(cwd); err != nil {
			return nil, false, err
		}
		addCmd := exec.Command("git", "add", "-A")
		addCmd.Dir = cwd
		if err := addCmd.Run(); err != nil {
			return nil, false, fmt.Errorf("git add -A: %w", err)
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
			return nil, false, fmt.Errorf("create initial commit: %w", err)
		}
	}

	return existingCfg, true, nil
}

func runInteractiveConfig(cwd string, yes bool, existingCfg *config.Config, detected []string) (config.Config, string, error) {
	available := detected
	if !yes && len(detected) > 1 {
		toolOpts := make([]huh.Option[string], len(detected))
		for i, name := range detected {
			preSelected := true
			if existingCfg != nil {
				preSelected = false
				for _, enabled := range existingCfg.Tools {
					if enabled == name {
						preSelected = true
						break
					}
				}
			}
			toolOpts[i] = huh.NewOption(name, name).Selected(preSelected)
		}
		var selected []string
		if err := huh.NewMultiSelect[string]().Title("Enable tools").Options(toolOpts...).Value(&selected).Run(); err != nil {
			return config.Config{}, "", err
		}
		if len(selected) == 0 {
			return config.Config{}, "", fmt.Errorf("at least one tool must be enabled")
		}
		available = selected
	}

	cfg, err := config.Default()
	if err != nil {
		return config.Config{}, "", fmt.Errorf("load default config: %w", err)
	}

	var toolModels []toolModelInfo
	for _, name := range available {
		if models, ok := config.ToolModels(name); ok {
			toolModels = append(toolModels, toolModelInfo{name: name, models: models})
		}
	}

	projectName := filepath.Base(cwd)
	integrationBranch := "orca/integration"
	maxParallelStr := "3"
	supervisorTool := available[0]
	supervisorModel := ""
	validationCmd := ""
	qualityScopeCheck := true
	qualityTestDelta := true

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
		if existingCfg.Orchestrator.SupervisorTool != "" {
			foundSupervisorTool := false
			for _, name := range available {
				if name == existingCfg.Orchestrator.SupervisorTool {
					foundSupervisorTool = true
					break
				}
			}
			if foundSupervisorTool {
				supervisorTool = existingCfg.Orchestrator.SupervisorTool
			}
		}
		supervisorModel = existingCfg.Orchestrator.SupervisorModel
		if len(existingCfg.Validation.Commands) > 0 {
			validationCmd = existingCfg.Validation.Commands[0]
		}
		qualityScopeCheck = existingCfg.Quality.ScopeCheck
		qualityTestDelta = existingCfg.Quality.TestDelta
	}

	if !yes {
		qualityOpts := []huh.Option[string]{
			huh.NewOption("Scope check", "scope").Selected(qualityScopeCheck),
			huh.NewOption("Test delta", "test").Selected(qualityTestDelta),
		}
		var qualitySelected []string

		groups := []*huh.Group{
			huh.NewGroup(
				huh.NewInput().Title("Project name").Value(&projectName),
				huh.NewInput().Title("Integration branch").Value(&integrationBranch),
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

		groups = append(groups,
			huh.NewGroup(
				huh.NewInput().Title("Validation command").Description("Test command to run after integration (leave empty to skip)").Placeholder("e.g. go test ./...").Value(&validationCmd),
				huh.NewMultiSelect[string]().Title("Quality gates").Options(qualityOpts...).Value(&qualitySelected),
			),
		)

		form := huh.NewForm(groups...)
		if err := form.Run(); err != nil {
			return config.Config{}, "", err
		}

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
			return config.Config{}, "", err
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
					return config.Config{}, "", err
				}
				break
			}
		}

		phaseConfigs, err := selectPhases(available, toolModels, existingCfg)
		if err != nil {
			return config.Config{}, "", err
		}

		qualityScopeCheck = false
		qualityTestDelta = false
		for _, v := range qualitySelected {
			switch v {
			case "scope":
				qualityScopeCheck = true
			case "test":
				qualityTestDelta = true
			}
		}

		cfg.Orchestrator.Phases = phaseConfigs
	} else {
		// Non-interactive: set all phases to first available tool
		for _, phase := range []string{interaction.PhaseExplore, interaction.PhasePlan, interaction.PhaseRun, interaction.PhaseReview, interaction.PhaseMerge, interaction.PhaseRetro} {
			cfg.Orchestrator.Phases[phase] = config.PhaseConfig{Tool: available[0]}
		}
	}

	maxParallel, _ := strconv.Atoi(maxParallelStr)
	if maxParallel < 1 {
		maxParallel = 3
	}

	cfg.Project.Name = projectName
	cfg.Project.IntegrationBranch = integrationBranch
	cfg.Workers.MaxParallel = maxParallel
	cfg.Tools = append([]string(nil), available...)
	cfg.DefaultTool = supervisorTool
	if strings.TrimSpace(cfg.DefaultTool) == "" && len(cfg.Tools) > 0 {
		cfg.DefaultTool = cfg.Tools[0]
	}
	cfg.DefaultModel = ""
	if strings.TrimSpace(cfg.DefaultTool) != "" {
		if strings.TrimSpace(supervisorModel) != "" && config.ValidateModel(cfg.DefaultTool, supervisorModel) != "" {
			cfg.DefaultModel = supervisorModel
		} else if models, ok := config.ToolModels(cfg.DefaultTool); ok && len(models) > 0 {
			cfg.DefaultModel = models[0]
		}
	}
	cfg.Orchestrator.SupervisorTool = supervisorTool
	cfg.Orchestrator.SupervisorModel = supervisorModel

	if validationCmd != "" {
		cfg.Validation.Commands = []string{validationCmd}
	}

	cfg.Quality.Enabled = qualityScopeCheck || qualityTestDelta
	cfg.Quality.ScopeCheck = qualityScopeCheck
	cfg.Quality.TestDelta = qualityTestDelta

	if len(cfg.Tools) == 0 {
		return config.Config{}, "", fmt.Errorf("at least one tool must be enabled")
	}

	return cfg, integrationBranch, nil
}

func selectPhases(available []string, toolModels []toolModelInfo, existingCfg *config.Config) (map[string]config.PhaseConfig, error) {
	phases := []string{interaction.PhaseExplore, interaction.PhasePlan, interaction.PhaseRun, interaction.PhaseReview, interaction.PhaseMerge, interaction.PhaseRetro}
	phaseToolSelections := make(map[string]string, len(phases))
	for _, phase := range phases {
		phaseToolSelections[phase] = available[0]
		if existingCfg != nil {
			if pc, ok := existingCfg.Orchestrator.Phases[phase]; ok && pc.Tool != "" {
				phaseToolSelections[phase] = pc.Tool
			}
		}
	}

	type phaseToolBinding struct {
		phase string
		value string
	}
	phaseBindings := make([]*phaseToolBinding, len(phases))
	var phaseFields []huh.Field
	for i, phase := range phases {
		pb := &phaseToolBinding{phase: phase, value: phaseToolSelections[phase]}
		phaseBindings[i] = pb
		opts := make([]huh.Option[string], len(available))
		for j, name := range available {
			opts[j] = huh.NewOption(name, name)
		}
		phaseFields = append(phaseFields, huh.NewSelect[string]().
			Title(fmt.Sprintf("%s phase tool", phase)).
			Options(opts...).
			Value(&pb.value))
	}
	if err := huh.NewForm(huh.NewGroup(phaseFields...)).Run(); err != nil {
		return nil, err
	}

	phaseModelSelections := make(map[string]string, len(phases))
	for _, pb := range phaseBindings {
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
					return nil, err
				}
				phaseModelSelections[pb.phase] = modelVal
				break
			}
		}
	}

	phaseConfigs := make(map[string]config.PhaseConfig)
	for _, pb := range phaseBindings {
		phaseConfigs[pb.phase] = config.PhaseConfig{
			Tool:  pb.value,
			Model: phaseModelSelections[pb.phase],
		}
	}

	return phaseConfigs, nil
}

func serializeConfig(cwd string, cfg *config.Config, integrationBranch string) error {
	orcaDir := filepath.Join(cwd, ".orca")
	if err := os.MkdirAll(orcaDir, 0755); err != nil {
		return fmt.Errorf("create .orca directory: %w", err)
	}
	if _, err := config.EnsureDefaultToolConfig(cwd); err != nil {
		return fmt.Errorf("ensure default tools config: %w", err)
	}
	if _, _, err := config.LoadToolConfigForRepo(cwd); err != nil {
		return fmt.Errorf("load tools config: %w", err)
	}
	dbPath := filepath.Join(orcaDir, "state.db")
	db, err := state.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()
	if err := cfg.SaveToDB(db.DB); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	// Write .gitignore BEFORE creating the integration branch so the branch
	// fork point already includes the ignore entry. Without this, checking out
	// the integration branch (or creating worktrees from it) would lose the
	// .gitignore change because it was never committed.
	if err := ensureOrcaIgnored(cwd); err != nil {
		return err
	}
	commitGitignore(cwd)

	branchCmd := exec.Command("git", "branch", integrationBranch)
	branchCmd.Dir = cwd
	if err := branchCmd.Run(); err != nil {
		checkCmd := exec.Command("git", "rev-parse", "--verify", integrationBranch)
		checkCmd.Dir = cwd
		if checkCmd.Run() != nil {
			return fmt.Errorf("failed to create integration branch: %w", err)
		}
	}

	return nil
}

// commitGitignore stages and commits .gitignore so the change is part of
// the branch history before any integration branch is forked from it.
// It also removes any .orca/ files from the index — .gitignore only
// prevents untracked files from being added; already-tracked files must
// be explicitly removed.
func commitGitignore(cwd string) {
	addCmd := exec.Command("git", "add", ".gitignore")
	addCmd.Dir = cwd
	if addCmd.Run() != nil {
		return
	}
	// Untrack .orca/ if it crept into the index (error is expected when
	// nothing is tracked — just ignore it).
	rmCmd := exec.Command("git", "rm", "-r", "--cached", "--quiet", ".orca/")
	rmCmd.Dir = cwd
	_ = rmCmd.Run()

	commitCmd := exec.Command("git", "commit", "-m", "chore: add .orca/ to .gitignore")
	commitCmd.Dir = cwd
	_ = commitCmd.Run()
}

// loadConfigFromDBPath returns the persisted config, or nil if no config row exists.
func loadConfigFromDBPath(dbPath string) (*config.Config, error) {
	if _, err := os.Stat(dbPath); err != nil {
		return nil, err
	}
	db, err := state.Open(dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	if !config.ExistsInDB(db.DB) {
		return nil, nil
	}
	return config.LoadFromDB(db.DB)
}

func detectTools() []string {
	candidates := config.AvailableTools()
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

	entries := []string{".orca/"}
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
