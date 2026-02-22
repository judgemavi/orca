package orchestrator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/prompts"
)

// SystemPrompt is the orchestrator system prompt loaded from prompts/orchestrator.md.
var SystemPrompt = strings.TrimSpace(prompts.Orchestrator) + "\n\n" + strings.TrimSpace(prompts.OutputStyle)

func WriteMCPConfig(repoDir, orcaBinary string) (string, error) {
	configPath := filepath.Join(repoDir, ".orca", "mcp.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
		return "", fmt.Errorf("create .orca directory: %w", err)
	}

	configData := map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"orca": map[string]interface{}{
				"command": orcaBinary,
				"args":    []string{"mcp"},
				"cwd":     repoDir,
			},
		},
	}

	data, err := json.MarshalIndent(configData, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal mcp config: %w", err)
	}
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return "", fmt.Errorf("write mcp config: %w", err)
	}
	return configPath, nil
}

func ResolveSupervisorTool(cfg *config.Config) (string, config.ToolConfig, error) {
	if cfg == nil {
		return "", config.ToolConfig{}, fmt.Errorf("config is nil")
	}
	var (
		name string
		tc   config.ToolConfig
	)
	if cfg.Orchestrator.SupervisorTool != "" {
		resolved, ok := cfg.Tools[cfg.Orchestrator.SupervisorTool]
		if !ok {
			return "", config.ToolConfig{}, fmt.Errorf("supervisor tool %q not found in tools config", cfg.Orchestrator.SupervisorTool)
		}
		name = cfg.Orchestrator.SupervisorTool
		tc = resolved
	} else {
		toolNames := make([]string, 0, len(cfg.Tools))
		for toolName := range cfg.Tools {
			toolNames = append(toolNames, toolName)
		}
		sort.Strings(toolNames)
		if len(toolNames) == 0 {
			return "", config.ToolConfig{}, fmt.Errorf("no tools configured")
		}
		name = toolNames[0]
		tc = cfg.Tools[name]
	}

	if cfg.Orchestrator.SupervisorModel != "" {
		tc.Model = cfg.Orchestrator.SupervisorModel
	}
	return name, tc, nil
}

// AllowedTools is the whitelist of tools the orchestrator agent may use.
// MCP tools for coordination + read-only tools for codebase understanding.
// No Write, Edit, Bash, or any file-mutation tools.
var AllowedTools = []string{
	// MCP tools (orca server)
	"mcp__orca__task_list",
	"mcp__orca__task_create",
	"mcp__orca__task_update",
	"mcp__orca__sprint_plan",
	"mcp__orca__sprint_start",
	"mcp__orca__sprint_status",
	"mcp__orca__sprint_cancel",
	"mcp__orca__sprint_reset",
	"mcp__orca__review_get",
	"mcp__orca__review_sprint",
	"mcp__orca__task_approve",
	"mcp__orca__task_request_changes",
	"mcp__orca__explore",
	"mcp__orca__integrate",
	// Read-only tools for codebase understanding
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
}

func BuildLaunchArgs(toolCfg config.ToolConfig, mcpConfigPath string) []string {
	args := []string{
		"--mcp-config", mcpConfigPath,
		"--allowedTools", strings.Join(AllowedTools, ","),
	}

	baseArgs := toolCfg.InteractiveArgs
	if len(baseArgs) == 0 {
		baseArgs = toolCfg.HeadlessArgs
	}
	if len(baseArgs) == 0 {
		return append(args, "-p", SystemPrompt)
	}

	hasPromptPlaceholder := false
	rendered := make([]string, len(baseArgs))
	for i, arg := range baseArgs {
		if strings.Contains(arg, "{{context}}") || strings.Contains(arg, "{{prompt}}") {
			hasPromptPlaceholder = true
		}
		arg = strings.ReplaceAll(arg, "{{context}}", SystemPrompt)
		arg = strings.ReplaceAll(arg, "{{prompt}}", SystemPrompt)
		rendered[i] = arg
	}

	args = append(args, rendered...)
	if !hasPromptPlaceholder {
		args = append(args, "-p", SystemPrompt)
	}
	if toolCfg.Model != "" {
		args = append(args, "--model", toolCfg.Model)
	}
	return args
}
