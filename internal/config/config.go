// Package config handles Orca configuration and tool adapter selection.
package config

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/logging"
)

type Config struct {
	Project      ProjectConfig      `json:"project"`
	Tools        []string           `json:"tools"`
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
	CostBudget      float64                `json:"cost_budget"`
	TaskBudget      float64                `json:"task_budget"`
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
	Tools:   []string{"claude"},
	Workers: WorkersConfig{MaxParallel: 3},
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

// Validate checks config values for semantic correctness.
func (c *Config) Validate() error {
	if c.Workers.MaxParallel < 1 {
		return fmt.Errorf("workers.max_parallel must be >= 1, got %d", c.Workers.MaxParallel)
	}

	for _, toolName := range c.Tools {
		if _, ok := driver.Get(toolName); !ok {
			return fmt.Errorf("tools contains unknown tool %q", toolName)
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

	if c.Orchestrator.CostBudget < 0 {
		return fmt.Errorf("orchestrator.cost_budget must be >= 0, got %v", c.Orchestrator.CostBudget)
	}
	if c.Orchestrator.TaskBudget < 0 {
		return fmt.Errorf("orchestrator.task_budget must be >= 0, got %v", c.Orchestrator.TaskBudget)
	}

	if c.Orchestrator.SupervisorTool != "" {
		if _, ok := driver.Get(c.Orchestrator.SupervisorTool); !ok {
			return fmt.Errorf("orchestrator.supervisor_tool %q not found in drivers", c.Orchestrator.SupervisorTool)
		}
	}
	for phase, phaseCfg := range c.Orchestrator.Phases {
		if phaseCfg.Tool == "" {
			continue
		}
		if _, ok := driver.Get(phaseCfg.Tool); !ok {
			return fmt.Errorf("orchestrator.phases.%s.tool %q not found in drivers", phase, phaseCfg.Tool)
		}
	}

	return nil
}

func (c *Config) ResolveToolForPhase(phase, override string) (string, driver.Driver, error) {
	toolName := strings.TrimSpace(override)
	if toolName == "" {
		if pc, ok := c.Orchestrator.Phases[phase]; ok && pc.Tool != "" {
			toolName = pc.Tool
		}
	}
	if toolName == "" && len(c.Tools) > 0 {
		toolName = c.Tools[0]
	}
	if toolName == "" {
		return "", nil, fmt.Errorf("no tool configured for phase %q", phase)
	}

	d, ok := driver.Get(toolName)
	if !ok {
		return "", nil, fmt.Errorf("tool %q not found", toolName)
	}
	return toolName, d, nil
}

func (c *Config) ResolveModelForPhase(phase, override string, d driver.Driver) string {
	if model := strings.TrimSpace(override); model != "" {
		if ValidateModel(d.Name(), model, d) != "" {
			return model
		}
	}
	if pc, ok := c.Orchestrator.Phases[phase]; ok {
		if model := strings.TrimSpace(pc.Model); model != "" {
			if ValidateModel(d.Name(), model, d) != "" {
				return model
			}
		}
	}
	models := d.Models()
	if len(models) > 0 {
		return models[0]
	}
	return ""
}

// ValidateModel returns model only when it's allowed by driver models.
func ValidateModel(toolName, model string, d driver.Driver) string {
	model = strings.TrimSpace(model)
	if model == "" {
		return ""
	}
	for _, m := range d.Models() {
		if m == model {
			return model
		}
	}
	if toolName == "" {
		toolName = d.Name()
	}
	slog.Warn(fmt.Sprintf("task model %q not in %s models list, using default", model, toolName))
	return ""
}
