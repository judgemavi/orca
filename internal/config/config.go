// Package config handles pod.yaml parsing and tool adapter configuration.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Project    ProjectConfig         `yaml:"project"`
	Tools      map[string]ToolConfig `yaml:"tools"`
	Validation ValidationConfig      `yaml:"validation"`
	Workers    WorkersConfig         `yaml:"workers"`
	Autopilot  AutopilotConfig       `yaml:"autopilot"`
}

type ProjectConfig struct {
	Name              string `yaml:"name"`
	IntegrationBranch string `yaml:"integration_branch"`
	WorktreeDir       string `yaml:"worktree_dir"`
}

type ToolConfig struct {
	Binary          string   `yaml:"binary"`
	InteractiveArgs []string `yaml:"interactive_args"`
	HeadlessArgs    []string `yaml:"headless_args"`
	Timeout         string   `yaml:"timeout"`
	Mode            string   `yaml:"mode"`
	PromptMode      string   `yaml:"prompt_mode"`
}

type ValidationConfig struct {
	Commands []string `yaml:"commands"`
}

type WorkersConfig struct {
	MaxParallel int `yaml:"max_parallel"`
}

type AutopilotConfig struct {
	Enabled              bool    `yaml:"enabled"`
	CostBudget           float64 `yaml:"cost_budget"`
	EscalateAfterRetries int     `yaml:"escalate_after_retries"`
	MaxSprints           int     `yaml:"max_sprints"`
	PauseOnReview        bool    `yaml:"pause_on_review"`
	SupervisorTool       string  `yaml:"supervisor_tool,omitempty"`
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

// Default returns a Config with sensible defaults for a new project.
func Default() *Config {
	return &Config{
		Project: ProjectConfig{
			IntegrationBranch: "pod/integration",
			WorktreeDir:       "/tmp/pod/worktrees",
		},
		Tools: map[string]ToolConfig{
			"claude": {
				Binary:          "claude",
				InteractiveArgs: []string{"--append-system-prompt", "{{context}}"},
				HeadlessArgs:    []string{"-p", "{{prompt}}", "--output-format", "json", "--permission-mode", "bypassPermissions"},
				Mode:            "headless",
				PromptMode:      "arg",
				Timeout:         "600s",
			},
			"codex": {
				Binary:       "codex",
				HeadlessArgs: []string{"exec", "{{prompt}}", "--full-auto"},
				Mode:         "headless",
				PromptMode:   "arg",
				Timeout:      "600s",
			},
			"aider": {
				Binary:          "aider",
				InteractiveArgs: []string{"--yes-always", "--no-auto-commits"},
				HeadlessArgs:    []string{"--message", "{{prompt}}", "--yes-always", "--no-auto-commits"},
				Mode:            "headless",
				PromptMode:      "arg",
				Timeout:         "600s",
			},
		},
		Workers: WorkersConfig{
			MaxParallel: 3,
		},
		Autopilot: AutopilotConfig{
			Enabled:              false,
			CostBudget:           0,
			EscalateAfterRetries: 2,
			MaxSprints:           10,
			PauseOnReview:        true,
		},
	}
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
