// Package config handles orca.yaml parsing and tool adapter configuration.
package config

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/logging"
	"gopkg.in/yaml.v3"
)

//go:embed defaults.yaml
var defaultsYAML []byte

type Config struct {
	Project      ProjectConfig         `yaml:"project" json:"project"`
	Tools        map[string]ToolConfig `yaml:"tools" json:"tools"`
	Defaults     DefaultsConfig        `yaml:"defaults" json:"defaults"`
	Validation   ValidationConfig      `yaml:"validation" json:"validation"`
	Workers      WorkersConfig         `yaml:"workers" json:"workers"`
	Orchestrator OrchestratorConfig    `yaml:"orchestrator" json:"orchestrator"`
	Monitor      MonitorConfig         `yaml:"monitor" json:"monitor"`
	Quality      QualityConfig         `yaml:"quality" json:"quality"`
	Logging      logging.Config        `yaml:"logging" json:"logging"`
	Cleanup      CleanupConfig         `yaml:"cleanup" json:"cleanup"`
	Server       ServerConfig          `yaml:"server" json:"server"`
}

type ServerConfig struct {
	Addr string `yaml:"addr" json:"addr"`
}

type ProjectConfig struct {
	Name              string `yaml:"name" json:"name"`
	IntegrationBranch string `yaml:"integration_branch" json:"integration_branch"`
	WorktreeDir       string `yaml:"worktree_dir" json:"worktree_dir"`
}

type ToolConfig struct {
	Binary           string           `yaml:"binary" json:"binary"`
	Model            string           `yaml:"model" json:"model,omitempty"`
	Models           []string         `yaml:"models" json:"models,omitempty"`
	InteractiveArgs  []string         `yaml:"interactive_args" json:"interactive_args,omitempty"`
	HeadlessArgs     []string         `yaml:"headless_args" json:"headless_args,omitempty"`
	ResumeArgs       []string         `yaml:"resume_args" json:"resume_args,omitempty"`
	SessionIDPattern string           `yaml:"session_id_pattern" json:"session_id_pattern,omitempty"`
	Timeout          string           `yaml:"timeout" json:"timeout"`
	Mode             string           `yaml:"mode" json:"mode"`
	PromptMode       string           `yaml:"prompt_mode" json:"prompt_mode"`
	Output           ToolOutputConfig `yaml:"output,omitempty" json:"output,omitempty"`
	Cost             ToolCostConfig   `yaml:"cost,omitempty" json:"cost,omitempty"`
}

type ToolOutputConfig struct {
	Mode        string `yaml:"mode,omitempty" json:"mode,omitempty"`
	ResultField string `yaml:"result_field,omitempty" json:"result_field,omitempty"`
	ResultPath  string `yaml:"result_path,omitempty" json:"result_path,omitempty"`
	Pattern     string `yaml:"pattern,omitempty" json:"pattern,omitempty"`
}

type ToolCostConfig struct {
	Mode        string `yaml:"mode,omitempty" json:"mode,omitempty"`
	CostField   string `yaml:"cost_field,omitempty" json:"cost_field,omitempty"`
	UsageInput  string `yaml:"usage_input,omitempty" json:"usage_input,omitempty"`
	UsageOutput string `yaml:"usage_output,omitempty" json:"usage_output,omitempty"`
	Pattern     string `yaml:"pattern,omitempty" json:"pattern,omitempty"`
}

func (t *ToolConfig) UnmarshalYAML(value *yaml.Node) error {
	type rawToolConfig ToolConfig
	var raw rawToolConfig
	if err := value.Decode(&raw); err != nil {
		return err
	}

	*t = ToolConfig(raw)
	if strings.TrimSpace(t.Output.Mode) == "" {
		t.Output.Mode = "stdout"
	}
	if strings.TrimSpace(t.Cost.Mode) == "" {
		t.Cost.Mode = "none"
	}

	return nil
}

type ValidationConfig struct {
	Commands []string `yaml:"commands" json:"commands"`
}

type WorkersConfig struct {
	MaxParallel int `yaml:"max_parallel" json:"max_parallel"`
}

type PhaseConfig struct {
	Tool  string `yaml:"tool" json:"tool"`
	Model string `yaml:"model" json:"model"`
}

type DefaultsConfig struct {
	Tool  string `yaml:"tool" json:"tool"`
	Model string `yaml:"model" json:"model"`
}

type OrchestratorConfig struct {
	CostBudget      float64                `yaml:"cost_budget" json:"cost_budget"`
	SupervisorTool  string                 `yaml:"supervisor_tool" json:"supervisor_tool"`
	SupervisorModel string                 `yaml:"supervisor_model" json:"supervisor_model"`
	Phases          map[string]PhaseConfig `yaml:"phases" json:"phases"`
}

type MonitorConfig struct {
	StuckCheckInterval string  `yaml:"stuck_check_interval" json:"stuck_check_interval"`
	MaxStuckCycles     int     `yaml:"max_stuck_cycles" json:"max_stuck_cycles"`
	ConflictInterval   string  `yaml:"conflict_check_interval" json:"conflict_check_interval"`
	TaskBudget         float64 `yaml:"task_budget" json:"task_budget"`
}

type QualityConfig struct {
	Enabled        bool `yaml:"enabled" json:"enabled"`
	ScopeCheck     bool `yaml:"scope_check" json:"scope_check"`
	TestDelta      bool `yaml:"test_delta" json:"test_delta"`
	AlignmentCheck bool `yaml:"alignment_check" json:"alignment_check"`
}

type CleanupConfig struct {
	TTL string `yaml:"ttl" json:"ttl"`
}

// Load reads and parses a orca.yaml config file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg, err := Default()
	if err != nil {
		return nil, err
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if cfg.Project.WorktreeDir != "" && !filepath.IsAbs(cfg.Project.WorktreeDir) {
		// Resolve relative to the repo root (parent of the .orca config dir).
		abs, err := filepath.Abs(filepath.Join(filepath.Dir(path), "..", cfg.Project.WorktreeDir))
		if err == nil {
			cfg.Project.WorktreeDir = abs
		}
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}
	return &cfg, nil
}

// Default returns a Config parsed from the embedded defaults.yaml.
func Default() (Config, error) {
	var cfg Config
	if err := yaml.Unmarshal(defaultsYAML, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse embedded defaults.yaml: %w", err)
	}
	return cfg, nil
}

// Save writes the config to a yaml file at path.
func (c *Config) Save(path string) error {
	data, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

// sectionComments maps top-level yaml keys to descriptive comments.
var sectionComments = map[string]string{
	"project":      "Project identity and branch settings",
	"tools":        "CLI tool adapters — binary paths, args, models, timeouts",
	"defaults":     "Default tool and model used when not overridden per-phase",
	"validation":   "Commands to run after integration (e.g. test suites)",
	"workers":      "Parallel worker settings",
	"orchestrator": "Supervisor agent config — tool, model, cost budget, per-phase overrides",
	"monitor":      "Stuck detection, conflict checking, per-task budget",
	"quality":      "Quality gates applied during review",
	"logging":      "Application logging config — level, file path, rotation size",
	"cleanup":      "Worktree cleanup settings",
	"server":       "Web UI server settings",
}

// SaveAnnotated writes the config with section header comments.
func (c *Config) SaveAnnotated(path string) error {
	var node yaml.Node
	if err := node.Encode(c); err != nil {
		return fmt.Errorf("encode config: %w", err)
	}

	// node.Encode produces a MappingNode; find it whether wrapped in a document or not.
	mapping := &node
	if node.Kind == yaml.DocumentNode && len(node.Content) > 0 {
		mapping = node.Content[0]
	}
	if mapping.Kind == yaml.MappingNode {
		for i := 0; i < len(mapping.Content)-1; i += 2 {
			key := mapping.Content[i]
			if comment, ok := sectionComments[key.Value]; ok {
				key.HeadComment = comment
			}
		}
	}

	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create config file: %w", err)
	}
	defer f.Close()

	enc := yaml.NewEncoder(f)
	enc.SetIndent(2)
	if err := enc.Encode(&node); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return enc.Close()
}

// Validate checks config values for semantic correctness.
func (c *Config) Validate() error {
	if c.Workers.MaxParallel < 1 {
		return fmt.Errorf("workers.max_parallel must be >= 1, got %d", c.Workers.MaxParallel)
	}

	toolNames := make([]string, 0, len(c.Tools))
	for name := range c.Tools {
		toolNames = append(toolNames, name)
	}
	sort.Strings(toolNames)

	for _, name := range toolNames {
		tool := c.Tools[name]
		if strings.TrimSpace(tool.Binary) == "" {
			return fmt.Errorf("tools.%s.binary must be non-empty", name)
		}

		d, err := time.ParseDuration(tool.Timeout)
		if err != nil {
			return fmt.Errorf("tools.%s.timeout must be a valid duration: %w", name, err)
		}
		if d <= 0 {
			return fmt.Errorf("tools.%s.timeout must be > 0, got %q", name, tool.Timeout)
		}
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
	if c.Monitor.TaskBudget < 0 {
		return fmt.Errorf("monitor.task_budget must be >= 0, got %v", c.Monitor.TaskBudget)
	}
	if c.Orchestrator.CostBudget < 0 {
		return fmt.Errorf("orchestrator.cost_budget must be >= 0, got %v", c.Orchestrator.CostBudget)
	}

	if c.Orchestrator.SupervisorTool != "" {
		if _, ok := c.Tools[c.Orchestrator.SupervisorTool]; !ok {
			return fmt.Errorf("orchestrator.supervisor_tool %q not found in tools", c.Orchestrator.SupervisorTool)
		}
	}
	if c.Defaults.Tool != "" {
		if _, ok := c.Tools[c.Defaults.Tool]; !ok {
			return fmt.Errorf("defaults.tool %q not found in tools", c.Defaults.Tool)
		}
	}

	return nil
}

// ResolvePhaseToolConfig returns the tool name and config for a given phase.
// Resolution: phases.<phase>.tool -> defaults.tool -> first alphabetical tool.
// Model override: phases.<phase>.model -> defaults.model -> tool's configured model.
func (c *Config) ResolvePhaseToolConfig(phase string) (string, ToolConfig, error) {
	if len(c.Tools) == 0 {
		return "", ToolConfig{}, fmt.Errorf("no tools configured")
	}

	var (
		toolName string
		ok       bool
	)

	if phaseCfg, phaseExists := c.Orchestrator.Phases[phase]; phaseExists && phaseCfg.Tool != "" {
		toolName = phaseCfg.Tool
		_, ok = c.Tools[toolName]
		if !ok {
			return "", ToolConfig{}, fmt.Errorf("unknown tool %q for orchestrator phase %q", toolName, phase)
		}
	} else if c.Defaults.Tool != "" {
		toolName = c.Defaults.Tool
		_, ok = c.Tools[toolName]
		if !ok {
			return "", ToolConfig{}, fmt.Errorf("unknown default tool %q", toolName)
		}
	} else {
		names := make([]string, 0, len(c.Tools))
		for name := range c.Tools {
			names = append(names, name)
		}
		sort.Strings(names)
		toolName = names[0]
	}

	toolCfg := c.Tools[toolName]
	if phaseCfg, phaseExists := c.Orchestrator.Phases[phase]; phaseExists && phaseCfg.Model != "" {
		toolCfg.Model = phaseCfg.Model
	} else if c.Defaults.Model != "" {
		toolCfg.Model = c.Defaults.Model
	}

	return toolName, toolCfg, nil
}
