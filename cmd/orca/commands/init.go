package commands

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/banner"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/model"
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

	fmt.Printf("\n✓ Orca initialized in %s\n\n", cwd)
	fmt.Println("Getting started:")
	fmt.Println("  orca explore                      Analyze codebase for context")
	fmt.Println("  orca tasks add \"task title\"        Add a task")
	fmt.Println("  orca tasks list                     View all tasks")
	fmt.Println("  orca breakdown \"goal\"             Break down a goal into tasks")
	fmt.Println("  orca sprint plan                  Select tasks for a sprint")
	fmt.Println("  orca sprint start                 Execute the sprint")
	fmt.Println("  orca sprint review                Review completed work")
	fmt.Println("  orca merge                        Merge approved tasks")
	fmt.Println("  orca run                          Do all of the above in one shot")
	fmt.Println("  orca status                       Show project overview")
	fmt.Println("  orca serve                        Open web UI")
	fmt.Println("  orca orc                          Launch orchestrator (autopilot)")
	return nil
}

func runInitPreflight(cwd string, yes bool) (*config.Config, bool, error) {
	orcaDir := filepath.Join(cwd, ".orca")

	var existingCfg *config.Config
	if _, err := os.Stat(orcaDir); err == nil {
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
		cfgPath := filepath.Join(orcaDir, "orca.yaml")
		if loaded, loadErr := config.Load(cfgPath); loadErr == nil {
			existingCfg = loaded
		}
	}

	if _, err := os.Stat(filepath.Join(cwd, ".git")); os.IsNotExist(err) {
		initRepo := yes
		if !yes {
			if err := huh.NewConfirm().Title("No git repository found").Description("Orca requires a git repo. Initialize one?").Affirmative("Yes").Negative("No").Value(&initRepo).Run(); err != nil {
				return nil, false, err
			}
		}
		if !initRepo {
			return nil, false, fmt.Errorf("orca init requires a git repository")
		}
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
				_, preSelected = existingCfg.Tools[name]
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
		if tc, ok := cfg.Tools[name]; ok {
			ms := model.FromConfig(name, tc)
			ids := make([]string, len(ms))
			for i, m := range ms {
				ids[i] = m.ID
			}
			toolModels = append(toolModels, toolModelInfo{name: name, models: ids})
		}
	}

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
		if existingCfg.Defaults.Tool != "" {
			foundDefaultTool := false
			for _, name := range available {
				if name == existingCfg.Defaults.Tool {
					foundDefaultTool = true
					break
				}
			}
			if foundDefaultTool {
				defaultTool = existingCfg.Defaults.Tool
			}
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
		costBudget = strconv.FormatFloat(existingCfg.Orchestrator.CostBudget, 'f', -1, 64)
		if len(existingCfg.Validation.Commands) > 0 {
			validationCmd = existingCfg.Validation.Commands[0]
		}
		qualityScopeCheck = existingCfg.Quality.ScopeCheck
		qualityTestDelta = existingCfg.Quality.TestDelta
		qualityAlignment = existingCfg.Quality.AlignmentCheck
	}

	if !yes {
		defaultToolOpts := make([]huh.Option[string], len(available))
		for i, name := range available {
			defaultToolOpts[i] = huh.NewOption(name, name)
		}

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

		qualityOpts := []huh.Option[string]{
			huh.NewOption("Scope check", "scope").Selected(qualityScopeCheck),
			huh.NewOption("Test delta", "test").Selected(qualityTestDelta),
			huh.NewOption("LLM alignment check", "alignment").Selected(qualityAlignment),
		}
		var qualitySelected []string

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

		phaseConfigs, err := selectPhases(defaultTool, available, toolModels, existingCfg)
		if err != nil {
			return config.Config{}, "", err
		}

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

		for _, mb := range modelBindings {
			if tc, ok := cfg.Tools[mb.name]; ok {
				tc.Model = mb.value
				cfg.Tools[mb.name] = tc
			}
		}

		if len(phaseConfigs) > 0 {
			cfg.Orchestrator.Phases = phaseConfigs
		}
	}

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
		return config.Config{}, "", fmt.Errorf("none of the selected tools are present in config defaults")
	}
	cfg.Tools = enabledTools

	return cfg, integrationBranch, nil
}

func selectPhases(defaultTool string, available []string, toolModels []toolModelInfo, existingCfg *config.Config) (map[string]config.PhaseConfig, error) {
	phases := []string{"explore", "plan", "sprint", "review", "merge"}
	phaseToolSelections := make(map[string]string, len(phases))
	for _, phase := range phases {
		phaseToolSelections[phase] = ""
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
		return nil, err
	}

	phaseModelSelections := make(map[string]string, len(phases))
	for _, pb := range phaseBindings {
		if pb.value == "" {
			continue
		}
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
		if pb.value == "" {
			continue
		}
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
	return nil
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

	entries := []string{".orca/worktrees/", ".orca/*.db", ".orca/*.db-wal", ".orca/*.db-shm", ".orca/orca.log*"}
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
