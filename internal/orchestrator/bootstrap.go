package orchestrator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/prompts"
)

// SystemPrompt is the orchestrator system prompt loaded from prompts/orchestrator.md.
var SystemPrompt = strings.TrimSpace(prompts.Orchestrator) + "\n\n" + strings.TrimSpace(prompts.OutputStyle)

func WriteMCPConfig(repoDir, podBinary string) (string, error) {
	configPath := filepath.Join(repoDir, ".pod", "mcp.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
		return "", fmt.Errorf("create .pod directory: %w", err)
	}

	configData := map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"pod": map[string]interface{}{
				"command": podBinary,
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
	// MCP tools (pod server)
	"mcp__pod__task_list",
	"mcp__pod__task_create",
	"mcp__pod__task_update",
	"mcp__pod__sprint_plan",
	"mcp__pod__sprint_start",
	"mcp__pod__sprint_status",
	"mcp__pod__sprint_cancel",
	"mcp__pod__sprint_reset",
	"mcp__pod__review_get",
	"mcp__pod__review_sprint",
	"mcp__pod__task_approve",
	"mcp__pod__task_request_changes",
	"mcp__pod__explore",
	"mcp__pod__integrate",
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
