// Package config handles Orca configuration and tool adapter selection.
package config

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/logging"
	"github.com/jasjeetmavi/orca/internal/toolcfg"
)

type Config struct {
	Project      ProjectConfig      `json:"project"`
	Tools        []string           `json:"tools"`
	DefaultTool  string             `json:"default_tool"`
	DefaultModel string             `json:"default_model"`
	Validation   ValidationConfig   `json:"validation"`
	Workers      WorkersConfig      `json:"workers"`
	Orchestrator OrchestratorConfig `json:"orchestrator"`
	Monitor      MonitorConfig      `json:"monitor"`
	Quality      QualityConfig      `json:"quality"`
	Logging      logging.Config     `json:"logging"`
}

type ProjectConfig struct {
	Name              string `json:"name"`
	IntegrationBranch string `json:"integration_branch"`
	WorktreeDir       string `json:"worktree_dir"`
}

type ValidationConfig struct {
	Commands []string `json:"commands"`
}

type WorkersConfig struct {
	MaxParallel int `json:"max_parallel"`
}

type PhaseConfig struct {
	Tool  string `json:"tool"`
	Model string `json:"model"`
}

type OrchestratorConfig struct {
	SupervisorTool  string                 `json:"supervisor_tool"`
	SupervisorModel string                 `json:"supervisor_model"`
	Phases          map[string]PhaseConfig `json:"phases"`
}

type MonitorConfig struct {
	StuckCheckInterval string `json:"stuck_check_interval"`
	MaxStuckCycles     int    `json:"max_stuck_cycles"`
	ConflictInterval   string `json:"conflict_check_interval"`
}

type QualityConfig struct {
	Enabled    bool `json:"enabled"`
	ScopeCheck bool `json:"scope_check"`
	TestDelta  bool `json:"test_delta"`
}

var defaultConfig = Config{
	Project: ProjectConfig{
		IntegrationBranch: "orca/integration",
		WorktreeDir:       ".orca/worktrees",
	},
	Tools:        []string{"claude"},
	DefaultTool:  "claude",
	DefaultModel: "claude-sonnet-4-6",
	Workers:      WorkersConfig{MaxParallel: 3},
	Orchestrator: OrchestratorConfig{
		SupervisorTool: "claude",
	},
	Monitor: MonitorConfig{
		StuckCheckInterval: "60s",
		MaxStuckCycles:     10,
		ConflictInterval:   "30s",
	},
	Quality: QualityConfig{Enabled: true, ScopeCheck: true, TestDelta: true},
	Logging: logging.Config{Level: "info", File: ".orca/orca.log", MaxSize: "50mb"},
}

// Default returns a copy of built-in defaults.
func Default() (Config, error) {
	cfg := defaultConfig
	if cfg.Orchestrator.Phases == nil {
		cfg.Orchestrator.Phases = map[string]PhaseConfig{}
	}
	cfg.Tools = append([]string(nil), cfg.Tools...)
	return cfg, nil
}

// Validate checks config values for semantic correctness against available tools.
func (c *Config) Validate() error {
	return c.validateWithTools(effectiveToolConfig(), true)
}

func (c *Config) validateLoaded() error {
	// Lenient validation to allow startup sanitization of stale tool/model refs.
	return c.validateWithTools(effectiveToolConfig(), false)
}

func (c *Config) validateWithTools(tc *toolcfg.Config, strictToolRefs bool) error {
	if c.Workers.MaxParallel < 1 {
		return fmt.Errorf("workers.max_parallel must be >= 1, got %d", c.Workers.MaxParallel)
	}

	if c.Monitor.StuckCheckInterval != "" {
		if _, err := time.ParseDuration(c.Monitor.StuckCheckInterval); err != nil {
			return fmt.Errorf("monitor.stuck_check_interval must be a valid duration: %w", err)
		}
	}
	if c.Monitor.ConflictInterval != "" {
		if _, err := time.ParseDuration(c.Monitor.ConflictInterval); err != nil {
			return fmt.Errorf("monitor.conflict_check_interval must be a valid duration: %w", err)
		}
	}
	if c.Monitor.MaxStuckCycles < 0 {
		return fmt.Errorf("monitor.max_stuck_cycles must be >= 0, got %d", c.Monitor.MaxStuckCycles)
	}

	if !strictToolRefs {
		return nil
	}

	if err := c.ValidateDefaults(tc); err != nil {
		return err
	}

	for _, toolName := range c.Tools {
		if !hasTool(tc, toolName) {
			return fmt.Errorf("tools contains unknown or unavailable tool %q", toolName)
		}
	}
	if len(c.Tools) == 0 {
		return fmt.Errorf("tools must contain at least one available tool")
	}

	supervisorTool := strings.TrimSpace(c.Orchestrator.SupervisorTool)
	if supervisorTool == "" {
		supervisorTool = strings.TrimSpace(c.DefaultTool)
	}
	if !hasTool(tc, supervisorTool) {
		return fmt.Errorf("orchestrator.supervisor_tool %q not found in available tools", supervisorTool)
	}
	if model := strings.TrimSpace(c.Orchestrator.SupervisorModel); model != "" {
		if !hasModel(tc, supervisorTool, model) {
			return fmt.Errorf("orchestrator.supervisor_model %q is invalid for tool %q", model, supervisorTool)
		}
	}

	for phase, phaseCfg := range c.Orchestrator.Phases {
		phaseTool := strings.TrimSpace(phaseCfg.Tool)
		if phaseTool == "" {
			phaseTool = strings.TrimSpace(c.DefaultTool)
		}
		if !hasTool(tc, phaseTool) {
			return fmt.Errorf("orchestrator.phases.%s.tool %q not found in available tools", phase, phaseTool)
		}
		if model := strings.TrimSpace(phaseCfg.Model); model != "" {
			if !hasModel(tc, phaseTool, model) {
				return fmt.Errorf("orchestrator.phases.%s.model %q is invalid for tool %q", phase, model, phaseTool)
			}
		}
	}

	return nil
}

// ValidateDefaults validates default_tool/default_model against available tools.
func (c *Config) ValidateDefaults(tc *toolcfg.Config) error {
	if tc == nil {
		tc = effectiveToolConfig()
	}

	defaultTool := strings.TrimSpace(c.DefaultTool)
	if defaultTool == "" {
		return fmt.Errorf("default_tool must be non-empty")
	}
	if !hasTool(tc, defaultTool) {
		return fmt.Errorf("default_tool %q not found in available tools", defaultTool)
	}

	defaultModel := strings.TrimSpace(c.DefaultModel)
	if defaultModel == "" {
		return fmt.Errorf("default_model must be non-empty")
	}
	if !hasModel(tc, defaultTool, defaultModel) {
		return fmt.Errorf("default_model %q is invalid for default_tool %q", defaultModel, defaultTool)
	}

	return nil
}

// SanitizeOrchestrator replaces stale tool/model references with defaults.
// It returns a human-readable list of changes applied.
func (c *Config) SanitizeOrchestrator(tc *toolcfg.Config) []string {
	if tc == nil {
		tc = effectiveToolConfig()
	}
	if c.Orchestrator.Phases == nil {
		c.Orchestrator.Phases = map[string]PhaseConfig{}
	}

	changes := make([]string, 0, 8)
	availableNames := sortedToolNames(tc)

	if strings.TrimSpace(c.DefaultTool) == "" && len(availableNames) > 0 {
		c.DefaultTool = availableNames[0]
		changes = append(changes, fmt.Sprintf("default_tool set to %q", c.DefaultTool))
	}
	if strings.TrimSpace(c.DefaultModel) == "" {
		if fallback := fallbackModelForTool(tc, c.DefaultTool, ""); fallback != "" {
			c.DefaultModel = fallback
			changes = append(changes, fmt.Sprintf("default_model set to %q", c.DefaultModel))
		}
	}

	if len(c.Tools) > 0 {
		filtered := make([]string, 0, len(c.Tools))
		seen := map[string]struct{}{}
		for _, toolName := range c.Tools {
			name := strings.TrimSpace(toolName)
			if name == "" {
				continue
			}
			if _, ok := seen[name]; ok {
				continue
			}
			seen[name] = struct{}{}
			if !hasTool(tc, name) {
				changes = append(changes, fmt.Sprintf("tools removed unavailable %q", name))
				continue
			}
			filtered = append(filtered, name)
		}
		if len(filtered) == 0 && hasTool(tc, c.DefaultTool) {
			filtered = append(filtered, c.DefaultTool)
			changes = append(changes, fmt.Sprintf("tools fallback to default_tool %q", c.DefaultTool))
		}
		if !equalStringSlices(c.Tools, filtered) {
			c.Tools = filtered
		}
	} else if hasTool(tc, c.DefaultTool) {
		c.Tools = []string{c.DefaultTool}
		changes = append(changes, fmt.Sprintf("tools initialized with default_tool %q", c.DefaultTool))
	}

	supervisorTool := strings.TrimSpace(c.Orchestrator.SupervisorTool)
	if supervisorTool == "" || !hasTool(tc, supervisorTool) {
		if hasTool(tc, c.DefaultTool) {
			if supervisorTool == "" {
				changes = append(changes, fmt.Sprintf("orchestrator.supervisor_tool set to default_tool %q", c.DefaultTool))
			} else {
				changes = append(changes, fmt.Sprintf("orchestrator.supervisor_tool %q replaced with default_tool %q", supervisorTool, c.DefaultTool))
			}
			c.Orchestrator.SupervisorTool = c.DefaultTool
			supervisorTool = c.DefaultTool
		}
	}

	if fallback := fallbackModelForTool(tc, supervisorTool, c.DefaultModel); fallback != "" {
		if current := strings.TrimSpace(c.Orchestrator.SupervisorModel); current == "" || !hasModel(tc, supervisorTool, current) {
			if current == "" {
				changes = append(changes, fmt.Sprintf("orchestrator.supervisor_model set to %q", fallback))
			} else {
				changes = append(changes, fmt.Sprintf("orchestrator.supervisor_model %q replaced with %q", current, fallback))
			}
			c.Orchestrator.SupervisorModel = fallback
		}
	}

	phaseNames := make([]string, 0, len(c.Orchestrator.Phases))
	for phase := range c.Orchestrator.Phases {
		phaseNames = append(phaseNames, phase)
	}
	sort.Strings(phaseNames)
	for _, phase := range phaseNames {
		phaseCfg := c.Orchestrator.Phases[phase]
		phaseTool := strings.TrimSpace(phaseCfg.Tool)
		if phaseTool == "" || !hasTool(tc, phaseTool) {
			if hasTool(tc, c.DefaultTool) {
				if phaseTool == "" {
					changes = append(changes, fmt.Sprintf("orchestrator.phases.%s.tool set to default_tool %q", phase, c.DefaultTool))
				} else {
					changes = append(changes, fmt.Sprintf("orchestrator.phases.%s.tool %q replaced with default_tool %q", phase, phaseTool, c.DefaultTool))
				}
				phaseCfg.Tool = c.DefaultTool
				phaseTool = c.DefaultTool
			}
		}

		if fallback := fallbackModelForTool(tc, phaseTool, c.DefaultModel); fallback != "" {
			phaseModel := strings.TrimSpace(phaseCfg.Model)
			if phaseModel == "" || !hasModel(tc, phaseTool, phaseModel) {
				if phaseModel == "" {
					changes = append(changes, fmt.Sprintf("orchestrator.phases.%s.model set to %q", phase, fallback))
				} else {
					changes = append(changes, fmt.Sprintf("orchestrator.phases.%s.model %q replaced with %q", phase, phaseModel, fallback))
				}
				phaseCfg.Model = fallback
			}
		}

		c.Orchestrator.Phases[phase] = phaseCfg
	}

	return changes
}

func (c *Config) ResolveToolForPhase(phase, override string) (string, toolcfg.Tool, error) {
	toolName := strings.TrimSpace(override)
	if toolName == "" {
		if pc, ok := c.Orchestrator.Phases[phase]; ok {
			toolName = strings.TrimSpace(pc.Tool)
		}
	}
	if toolName == "" {
		toolName = strings.TrimSpace(c.DefaultTool)
	}
	if toolName == "" && len(c.Tools) > 0 {
		toolName = strings.TrimSpace(c.Tools[0])
	}
	if toolName == "" {
		return "", toolcfg.Tool{}, fmt.Errorf("no tool configured for phase %q", phase)
	}
	tool, ok := ToolDefinition(toolName)
	if !ok {
		return "", toolcfg.Tool{}, fmt.Errorf("tool %q not found", toolName)
	}
	return toolName, tool, nil
}

func (c *Config) ResolveModelForPhase(phase, override, toolName string) string {
	toolName = strings.TrimSpace(toolName)
	if toolName == "" {
		if pc, ok := c.Orchestrator.Phases[phase]; ok && pc.Tool != "" {
			toolName = strings.TrimSpace(pc.Tool)
		}
	}
	if toolName == "" {
		toolName = strings.TrimSpace(c.DefaultTool)
	}
	if toolName == "" && len(c.Tools) > 0 {
		toolName = strings.TrimSpace(c.Tools[0])
	}

	if model := strings.TrimSpace(override); model != "" {
		if ValidateModel(toolName, model) != "" {
			return model
		}
	}
	if pc, ok := c.Orchestrator.Phases[phase]; ok {
		if model := strings.TrimSpace(pc.Model); model != "" {
			if ValidateModel(toolName, model) != "" {
				return model
			}
		}
	}
	if model := strings.TrimSpace(c.DefaultModel); model != "" {
		if ValidateModel(toolName, model) != "" {
			return model
		}
	}
	models := ModelsForTool(toolName)
	if len(models) > 0 {
		return models[0]
	}
	return ""
}

// ValidateModel returns model only when it's allowed by configured models.
func ValidateModel(toolName, model string) string {
	model = strings.TrimSpace(model)
	if model == "" {
		return ""
	}

	for _, m := range ModelsForTool(toolName) {
		if m == model {
			return model
		}
	}
	if toolName == "" {
		toolName = "tool"
	}
	slog.Warn(fmt.Sprintf("task model %q not in %s models list, using default", model, toolName))
	return ""
}

func hasTool(tc *toolcfg.Config, toolName string) bool {
	if tc == nil {
		return false
	}
	toolName = strings.TrimSpace(toolName)
	if toolName == "" {
		return false
	}
	_, ok := tc.Tools[toolName]
	return ok
}

func hasModel(tc *toolcfg.Config, toolName, model string) bool {
	if tc == nil {
		return false
	}
	toolName = strings.TrimSpace(toolName)
	model = strings.TrimSpace(model)
	if toolName == "" || model == "" {
		return false
	}
	tool, ok := tc.Tools[toolName]
	if !ok {
		return false
	}
	for _, id := range tool.Models {
		if strings.TrimSpace(id) == model {
			return true
		}
	}
	return false
}

func fallbackModelForTool(tc *toolcfg.Config, toolName, defaultModel string) string {
	toolName = strings.TrimSpace(toolName)
	if toolName == "" {
		return ""
	}
	defaultModel = strings.TrimSpace(defaultModel)
	if defaultModel != "" && hasModel(tc, toolName, defaultModel) {
		return defaultModel
	}
	tool, ok := tc.Tools[toolName]
	if !ok {
		return ""
	}
	if len(tool.Models) == 0 {
		return ""
	}
	return strings.TrimSpace(tool.Models[0])
}

func sortedToolNames(tc *toolcfg.Config) []string {
	if tc == nil {
		return nil
	}
	names := make([]string, 0, len(tc.Tools))
	for name := range tc.Tools {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func containsString(items []string, needle string) bool {
	needle = strings.TrimSpace(needle)
	if needle == "" {
		return false
	}
	for _, item := range items {
		if strings.TrimSpace(item) == needle {
			return true
		}
	}
	return false
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
