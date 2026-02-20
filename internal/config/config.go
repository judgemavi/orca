// Package config handles pod.yaml parsing and tool adapter configuration.
package config

import (
	_ "embed"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

//go:embed defaults.yaml
var defaultsYAML []byte

type Config struct {
	Project    ProjectConfig         `yaml:"project" json:"project"`
	Tools      map[string]ToolConfig `yaml:"tools" json:"tools"`
	Validation ValidationConfig      `yaml:"validation" json:"validation"`
	Workers    WorkersConfig         `yaml:"workers" json:"workers"`
	Autopilot  AutopilotConfig       `yaml:"autopilot" json:"autopilot"`
}

type ProjectConfig struct {
	Name              string `yaml:"name" json:"name"`
	IntegrationBranch string `yaml:"integration_branch" json:"integration_branch"`
	WorktreeDir       string `yaml:"worktree_dir" json:"worktree_dir"`
}

type ToolConfig struct {
	Binary          string   `yaml:"binary" json:"binary"`
	Model           string   `yaml:"model" json:"model,omitempty"`
	Models          []string `yaml:"models" json:"models,omitempty"`
	InteractiveArgs []string `yaml:"interactive_args" json:"interactive_args,omitempty"`
	HeadlessArgs    []string `yaml:"headless_args" json:"headless_args,omitempty"`
	Timeout         string   `yaml:"timeout" json:"timeout"`
	Mode            string   `yaml:"mode" json:"mode"`
	PromptMode      string   `yaml:"prompt_mode" json:"prompt_mode"`
}

type ValidationConfig struct {
	Commands []string `yaml:"commands" json:"commands"`
}

type WorkersConfig struct {
	MaxParallel int `yaml:"max_parallel" json:"max_parallel"`
}

type AutopilotConfig struct {
	Enabled              bool    `yaml:"enabled" json:"enabled"`
	CostBudget           float64 `yaml:"cost_budget" json:"cost_budget"`
	EscalateAfterRetries int     `yaml:"escalate_after_retries" json:"escalate_after_retries"`
	MaxSprints           int     `yaml:"max_sprints" json:"max_sprints"`
	PauseOnReview        bool    `yaml:"pause_on_review" json:"pause_on_review"`
	SupervisorTool       string  `yaml:"supervisor_tool,omitempty" json:"supervisor_tool,omitempty"`
}

// Load reads and parses a pod.yaml config file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return &cfg, nil
}

// Default returns a Config parsed from the embedded defaults.yaml.
func Default() *Config {
	var cfg Config
	if err := yaml.Unmarshal(defaultsYAML, &cfg); err != nil {
		panic(fmt.Sprintf("parse embedded defaults.yaml: %v", err))
	}
	return &cfg
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
