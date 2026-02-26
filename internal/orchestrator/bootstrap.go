package orchestrator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/driver"
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

func ResolveSupervisorTool(cfg *config.Config) (string, driver.Driver, string, error) {
	if cfg == nil {
		return "", nil, "", fmt.Errorf("config is nil")
	}
	name := cfg.Orchestrator.SupervisorTool
	if name == "" {
		if len(cfg.Tools) == 0 {
			return "", nil, "", fmt.Errorf("no tools configured")
		}
		name = cfg.Tools[0]
	}
	d, ok := driver.Get(name)
	if !ok {
		return "", nil, "", fmt.Errorf("supervisor tool %q not found", name)
	}
	model := cfg.ResolveModelForPhase("", cfg.Orchestrator.SupervisorModel, d)
	return name, d, model, nil
}

var AllowedTools = []string{
	// Task lifecycle
	"mcp__orca__tasks_list",
	"mcp__orca__tasks_get",
	"mcp__orca__tasks_create",
	"mcp__orca__tasks_update",
	"mcp__orca__tasks_delete",
	"mcp__orca__tasks_cancel",
	"mcp__orca__tasks_reopen",
	"mcp__orca__tasks_add_dependency",
	// Planning
	"mcp__orca__breakdown",
	"mcp__orca__tasks_plan_evaluate",
	"mcp__orca__tasks_plan_generate",
	"mcp__orca__tasks_approve_plan",
	"mcp__orca__tasks_request_plan_changes",
	// Execution
	"mcp__orca__tasks_run",
	// Review
	"mcp__orca__tasks_approve",
	"mcp__orca__tasks_request_changes",
	"mcp__orca__ai_review",
	"mcp__orca__tasks_reviews",
	// Integration
	"mcp__orca__merge",
	"mcp__orca__tasks_merge",
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

func BuildLaunchArgs(d driver.Driver, model, mcpConfigPath string) []string {
	if d == nil {
		return nil
	}
	sd, ok := d.(driver.SupervisorDriver)
	if !ok {
		return nil
	}
	allowedToolsStr := strings.Join(AllowedTools, ",")
	return sd.InteractiveArgs(mcpConfigPath, allowedToolsStr, SystemPrompt, model)
}
