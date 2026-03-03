package orchestrator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/toolcfg"
	"github.com/jasjeetmavi/orca/prompts"
)

var SystemPrompt = strings.TrimSpace(prompts.Orchestrator) + "\n\n" + strings.TrimSpace(prompts.OutputStyle)

func WriteMCPConfig(repoDir, orcaBinary string, tools []string) (string, error) {
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

	for _, name := range tools {
		if strings.EqualFold(name, "codex") {
			if err := writeCodexMCPConfig(repoDir, orcaBinary); err != nil {
				return "", fmt.Errorf("write codex mcp config: %w", err)
			}
			break
		}
	}

	return claudePath, nil
}

func writeCodexMCPConfig(repoDir, orcaBinary string) error {
	codexDir := filepath.Join(repoDir, ".codex")
	if err := os.MkdirAll(codexDir, 0755); err != nil {
		return err
	}

	codexPath := filepath.Join(codexDir, "config.toml")
	orcaBlock := fmt.Sprintf("[mcp_servers.orca]\ncommand = %q\nargs = [\"mcp\"]\ncwd = %q\n", orcaBinary, repoDir)

	existing, err := os.ReadFile(codexPath)
	if err != nil {
		if writeErr := os.WriteFile(codexPath, []byte(orcaBlock), 0644); writeErr != nil {
			return writeErr
		}
		return nil
	}

	content := string(existing)
	const marker = "[mcp_servers.orca]"
	if idx := strings.Index(content, marker); idx >= 0 {
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

func ResolveSupervisorTool(cfg *config.Config, repoDir string) (string, toolcfg.Tool, string, error) {
	if cfg == nil {
		return "", toolcfg.Tool{}, "", fmt.Errorf("config is nil")
	}
	name := cfg.Orchestrator.SupervisorTool
	if name == "" {
		if len(cfg.Tools) == 0 {
			return "", toolcfg.Tool{}, "", fmt.Errorf("no tools configured")
		}
		name = cfg.Tools[0]
	}
	if !config.IsKnownTool(name) {
		return "", toolcfg.Tool{}, "", fmt.Errorf("supervisor tool %q not found", name)
	}
	tool, err := ResolveToolDefinition(repoDir, name)
	if err != nil {
		return "", toolcfg.Tool{}, "", fmt.Errorf("resolve supervisor tool %q definition: %w", name, err)
	}
	model := cfg.ResolveModelForPhase("", cfg.Orchestrator.SupervisorModel, name)
	return name, tool, model, nil
}

var AllowedTools = []string{
	// Task lifecycle
	"mcp__orca__tasks_list",
	"mcp__orca__tasks_get",
	"mcp__orca__tasks_create",
	"mcp__orca__tasks_update",
	"mcp__orca__tasks_delete",
	"mcp__orca__tasks_start",
	"mcp__orca__tasks_stop",
	"mcp__orca__tasks_resume",
	"mcp__orca__tasks_add_dependency",
	// Planning
	"mcp__orca__breakdown",
	"mcp__orca__tasks_plan_evaluate",
	"mcp__orca__tasks_plan_generate",
	"mcp__orca__tasks_approve_plan",
	"mcp__orca__tasks_request_plan_changes",
	// Review
	"mcp__orca__tasks_approve",
	"mcp__orca__tasks_request_changes",
	"mcp__orca__ai_review",
	"mcp__orca__tasks_reviews",
	"mcp__orca__tasks_retro",
	// Integration
	"mcp__orca__merge",
	"mcp__orca__tasks_merge",
	// Memory
	"mcp__orca__memory_list",
	"mcp__orca__memory_search",
	"mcp__orca__memory_query",
	"mcp__orca__memory_sync",
	"mcp__orca__memory_refresh",
	"mcp__orca__memory_status",
	// Interactions
	"mcp__orca__interactions_list",
	"mcp__orca__interaction_get",
	// Exploration
	"mcp__orca__explore",
	"mcp__orca__explore_status",
	// Project & config
	"mcp__orca__project_status",
	"mcp__orca__config_get",
	"mcp__orca__models_list",
	// Operations
	"mcp__orca__worktree_cleanup",
	"mcp__orca__worktree_status",
	"mcp__orca__cost_status",
	"mcp__orca__quality_results",
	// Read-only inspection
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
}

func BuildLaunchArgs(tool toolcfg.Tool, model, mcpConfigPath string) []string {
	if strings.TrimSpace(tool.Binary) == "" {
		return nil
	}
	args := tool.ResolveArgs(toolcfg.ArgsModeInteractive, map[string]string{
		"mcp_config":    mcpConfigPath,
		"allowed_tools": strings.Join(AllowedTools, ","),
		"context":       SystemPrompt,
		"model":         model,
	})
	return compactArgs(args)
}

func ResolveToolDefinition(pathHint, toolName string) (toolcfg.Tool, error) {
	toolName = strings.TrimSpace(toolName)
	if toolName == "" {
		return toolcfg.Tool{}, fmt.Errorf("tool name is required")
	}

	loaded, _, err := loadToolConfig(pathHint)
	if err == nil {
		tool, ok := loaded.Tools[toolName]
		if !ok {
			return toolcfg.Tool{}, fmt.Errorf("tool %q not defined in tools config", toolName)
		}
		return tool, nil
	}

	defaultCfg, parseErr := toolcfg.DefaultConfig()
	if parseErr != nil {
		return toolcfg.Tool{}, fmt.Errorf("load embedded tools config: %w", parseErr)
	}
	if tool, ok := defaultCfg.Tools[toolName]; ok {
		return tool, nil
	}
	return toolcfg.Tool{}, err
}

func loadToolConfig(pathHint string) (*toolcfg.Config, string, error) {
	candidates := candidateToolConfigPaths(pathHint)
	var lastErr error
	for _, candidate := range candidates {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		if _, err := os.Stat(candidate); err != nil {
			lastErr = err
			continue
		}
		cfg, err := toolcfg.Load(candidate)
		if err != nil {
			lastErr = err
			continue
		}
		return cfg, candidate, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("tools config not found")
	}
	return nil, "", lastErr
}

func candidateToolConfigPaths(pathHint string) []string {
	seen := map[string]struct{}{}
	add := func(out *[]string, path string) {
		path = strings.TrimSpace(path)
		if path == "" {
			return
		}
		if _, ok := seen[path]; ok {
			return
		}
		seen[path] = struct{}{}
		*out = append(*out, path)
	}

	paths := make([]string, 0, 16)
	if envPath := strings.TrimSpace(os.Getenv("ORCA_TOOLS_CONFIG")); envPath != "" {
		add(&paths, envPath)
	}

	absHint := strings.TrimSpace(pathHint)
	if absHint == "" {
		if cwd, err := os.Getwd(); err == nil {
			absHint = cwd
		}
	}
	if absHint != "" {
		if !filepath.IsAbs(absHint) {
			if abs, err := filepath.Abs(absHint); err == nil {
				absHint = abs
			}
		}
		info, err := os.Stat(absHint)
		if err == nil && !info.IsDir() {
			absHint = filepath.Dir(absHint)
		}
	}

	for dir := absHint; strings.TrimSpace(dir) != ""; dir = filepath.Dir(dir) {
		add(&paths, filepath.Join(dir, ".orca", "tools.json"))
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}

	return paths
}

func compactArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		current := strings.TrimSpace(args[i])
		if current == "" {
			continue
		}
		if takesValueFlag(current) && i+1 < len(args) && strings.TrimSpace(args[i+1]) == "" {
			i++
			continue
		}
		out = append(out, args[i])
	}
	return out
}

func takesValueFlag(arg string) bool {
	switch arg {
	case "--model", "--mcp-config", "--allowedTools", "--append-system-prompt", "--resume", "-C", "--prompt", "-p":
		return true
	default:
		return false
	}
}
