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

// WriteMCPConfig writes tool-specific MCP configuration files.
// It always writes the Claude JSON config (.orca/mcp.json) and returns its path.
// When "codex" is present in tools, it also merges the orca MCP server into
// the project's .codex/config.toml without clobbering existing servers.
func WriteMCPConfig(repoDir, orcaBinary string, tools map[string]config.ToolConfig) (string, error) {
	// Claude: .orca/mcp.json (passed via --mcp-config flag)
	claudePath := filepath.Join(repoDir, ".orca", "mcp.json")
	if err := os.MkdirAll(filepath.Dir(claudePath), 0755); err != nil {
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
	if err := os.WriteFile(claudePath, data, 0644); err != nil {
		return "", fmt.Errorf("write mcp config: %w", err)
	}

	// Codex: .codex/config.toml (auto-discovered from project dir)
	if _, ok := tools["codex"]; ok {
		if err := writeCodexMCPConfig(repoDir, orcaBinary); err != nil {
			return "", fmt.Errorf("write codex mcp config: %w", err)
		}
	}

	return claudePath, nil
}

// writeCodexMCPConfig merges the orca MCP server into .codex/config.toml.
// It preserves any existing content outside the [mcp_servers.orca] block.
func writeCodexMCPConfig(repoDir, orcaBinary string) error {
	codexDir := filepath.Join(repoDir, ".codex")
	if err := os.MkdirAll(codexDir, 0755); err != nil {
		return err
	}

	codexPath := filepath.Join(codexDir, "config.toml")
	orcaBlock := fmt.Sprintf("[mcp_servers.orca]\ncommand = %q\nargs = [\"mcp\"]\ncwd = %q\n",
		orcaBinary, repoDir)

	existing, err := os.ReadFile(codexPath)
	if err != nil {
		// No existing file — write fresh.
		if writeErr := os.WriteFile(codexPath, []byte(orcaBlock), 0644); writeErr != nil {
			return writeErr
		}
		return nil
	}

	content := string(existing)

	// If orca server already defined, replace the block. Otherwise append.
	const marker = "[mcp_servers.orca]"
	if idx := strings.Index(content, marker); idx >= 0 {
		// Find end of block: next [section] or EOF.
		end := len(content)
		if next := strings.Index(content[idx+len(marker):], "\n["); next >= 0 {
			end = idx + len(marker) + next + 1
		}
		content = content[:idx] + orcaBlock + content[end:]
	} else {
		if len(content) > 0 && !strings.HasSuffix(content, "\n") {
			content += "\n"
		}
		content += "\n" + orcaBlock
	}

	if err := os.WriteFile(codexPath, []byte(content), 0644); err != nil {
		return err
	}
	return nil
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
	// MCP tools — tasks
	"mcp__orca__tasks_list",
	"mcp__orca__tasks_get",
	"mcp__orca__tasks_create",
	"mcp__orca__tasks_update",
	"mcp__orca__tasks_delete",
	"mcp__orca__tasks_reopen",
	"mcp__orca__tasks_add_dependency",
	"mcp__orca__tasks_approve",
	"mcp__orca__tasks_request_changes",
	// MCP tools — planning
	"mcp__orca__breakdown",
	"mcp__orca__tasks_plan_evaluate",
	"mcp__orca__task_plan_generate",
	"mcp__orca__task_merge",
	// MCP tools — sprint
	"mcp__orca__sprint_plan",
	"mcp__orca__sprint_start",
	"mcp__orca__sprint_status",
	"mcp__orca__sprint_assign",
	"mcp__orca__sprint_unassign",
	"mcp__orca__sprint_cancel",
	"mcp__orca__sprint_reset",
	"mcp__orca__sprint_resume",
	// MCP tools — review
	"mcp__orca__review_get",
	"mcp__orca__review_sprint",
	// MCP tools — integration
	"mcp__orca__merge",
	// MCP tools — exploration
	"mcp__orca__explore",
	"mcp__orca__explore_status",
	// MCP tools — operations
	"mcp__orca__worktree_cleanup",
	"mcp__orca__worktree_status",
	"mcp__orca__budget_status",
	"mcp__orca__quality_results",
	"mcp__orca__project_status",
	// Read-only tools for codebase understanding
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
}

// containsPlaceholder reports whether any arg in the slice contains the given placeholder.
func containsPlaceholder(args []string, placeholder string) bool {
	for _, a := range args {
		if strings.Contains(a, placeholder) {
			return true
		}
	}
	return false
}

func BuildLaunchArgs(toolCfg config.ToolConfig, mcpConfigPath string) []string {
	baseArgs := toolCfg.InteractiveArgs
	if len(baseArgs) == 0 {
		baseArgs = toolCfg.HeadlessArgs
	}
	if len(baseArgs) == 0 {
		return nil
	}

	allowedToolsStr := strings.Join(AllowedTools, ",")

	rendered := make([]string, 0, len(baseArgs))
	for _, arg := range baseArgs {
		arg = strings.ReplaceAll(arg, "{{context}}", SystemPrompt)
		arg = strings.ReplaceAll(arg, "{{prompt}}", SystemPrompt)
		arg = strings.ReplaceAll(arg, "{{mcp_config}}", mcpConfigPath)
		arg = strings.ReplaceAll(arg, "{{allowed_tools}}", allowedToolsStr)
		if toolCfg.Model != "" {
			arg = strings.ReplaceAll(arg, "{{model}}", toolCfg.Model)
		}
		rendered = append(rendered, arg)
	}

	if toolCfg.Model != "" && !containsPlaceholder(baseArgs, "{{model}}") {
		rendered = append(rendered, "--model", toolCfg.Model)
	}
	return rendered
}
