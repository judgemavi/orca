package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/jasjeetmavi/orca/internal/toolcfg"
)

const (
	// DefaultToolsConfigRelativePath is the primary location for tool definitions.
	DefaultToolsConfigRelativePath = ".orca/tools.json"
)

var lookPath = exec.LookPath

var (
	toolCfgMu         sync.RWMutex
	toolCfgDefined    *toolcfg.Config
	toolCfgAvailable  *toolcfg.Config
	toolCfgPath       string
	bundledCfgOnce    sync.Once
	bundledDefinedCfg *toolcfg.Config
	bundledAvailCfg   *toolcfg.Config
)

// ToolConfig returns the loaded and available (binary-present) tool definitions, if any.
func ToolConfig() *toolcfg.Config {
	toolCfgMu.RLock()
	defer toolCfgMu.RUnlock()
	return toolCfgAvailable
}

// DefinedToolConfig returns the loaded tool definitions before binary-availability filtering.
func DefinedToolConfig() *toolcfg.Config {
	toolCfgMu.RLock()
	defer toolCfgMu.RUnlock()
	return toolCfgDefined
}

// AvailableToolConfig returns the active available tool set (loaded or embedded fallback).
func AvailableToolConfig() *toolcfg.Config {
	return effectiveToolConfig()
}

// LoadedToolConfigPath returns the active tool config file path.
func LoadedToolConfigPath() string {
	toolCfgMu.RLock()
	defer toolCfgMu.RUnlock()
	return toolCfgPath
}

// SetToolConfig sets in-memory tool definitions.
func SetToolConfig(cfg *toolcfg.Config) {
	setToolConfig(cfg, "")
}

func setToolConfig(cfg *toolcfg.Config, path string) {
	toolCfgMu.Lock()
	defer toolCfgMu.Unlock()
	toolCfgDefined = cfg
	if cfg == nil {
		toolCfgAvailable = nil
		toolCfgPath = path
		return
	}
	toolCfgAvailable = filterAvailableTools(cfg, path)
	toolCfgPath = path
}

func bundledToolConfig() *toolcfg.Config {
	bundledCfgOnce.Do(func() {
		parsed, err := toolcfg.DefaultConfig()
		if err != nil {
			// Keep runtime stable even if embedded defaults are invalid.
			empty := &toolcfg.Config{Tools: map[string]toolcfg.Tool{}}
			bundledDefinedCfg = empty
			bundledAvailCfg = empty
			return
		}
		bundledDefinedCfg = parsed
		bundledAvailCfg = filterAvailableTools(parsed, "embedded defaults")
	})
	if bundledAvailCfg == nil {
		return &toolcfg.Config{Tools: map[string]toolcfg.Tool{}}
	}
	return bundledAvailCfg
}

func effectiveToolConfig() *toolcfg.Config {
	if cfg := ToolConfig(); cfg != nil {
		return cfg
	}
	return bundledToolConfig()
}

func filterAvailableTools(cfg *toolcfg.Config, source string) *toolcfg.Config {
	if cfg == nil {
		return &toolcfg.Config{Tools: map[string]toolcfg.Tool{}}
	}

	names := make([]string, 0, len(cfg.Tools))
	for name := range cfg.Tools {
		names = append(names, name)
	}
	sort.Strings(names)

	available := make(map[string]toolcfg.Tool, len(cfg.Tools))
	for _, name := range names {
		tool := cfg.Tools[name]
		binary := strings.TrimSpace(tool.Binary)
		if binary == "" {
			slog.Warn("tool excluded: empty binary", "tool", name, "source", source)
			continue
		}
		if _, err := lookPath(binary); err != nil {
			slog.Warn("tool excluded: binary not found", "tool", name, "binary", binary, "source", source)
			continue
		}
		available[name] = tool
	}

	return &toolcfg.Config{Tools: available}
}

// DefaultToolsConfigPath returns the preferred tools.json location for a repository.
func DefaultToolsConfigPath(repoDir string) string {
	return filepath.Join(repoDir, DefaultToolsConfigRelativePath)
}

// ToolConfigSearchPaths returns candidate locations in lookup order.
func ToolConfigSearchPaths(repoDir string) []string {
	return []string{DefaultToolsConfigPath(repoDir)}
}

// LoadToolConfigForRepo loads .orca/tools.json when present and stores it globally.
// If no tools config is present, it clears any existing in-memory config and returns nil.
func LoadToolConfigForRepo(repoDir string) (*toolcfg.Config, string, error) {
	setToolConfig(nil, "")

	for _, path := range ToolConfigSearchPaths(repoDir) {
		_, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, "", fmt.Errorf("stat tools config %q: %w", path, err)
		}

		parsed, err := toolcfg.Load(path)
		if err != nil {
			return nil, path, err
		}
		setToolConfig(parsed, path)
		return ToolConfig(), path, nil
	}

	return nil, "", nil
}

// EnsureDefaultToolConfig writes a default tools.json when no tool config exists.
func EnsureDefaultToolConfig(repoDir string) (string, error) {
	for _, path := range ToolConfigSearchPaths(repoDir) {
		_, err := os.Stat(path)
		if err == nil {
			return path, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("stat tools config %q: %w", path, err)
		}
	}

	path := DefaultToolsConfigPath(repoDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("create tools config directory: %w", err)
	}
	if err := os.WriteFile(path, toolcfg.DefaultToolsJSON, 0o644); err != nil {
		return "", fmt.Errorf("write default tools config: %w", err)
	}
	return path, nil
}

// IsKnownTool checks if a tool name is present in active available tools.
func IsKnownTool(toolName string) bool {
	toolName = strings.TrimSpace(toolName)
	if toolName == "" {
		return false
	}
	_, ok := effectiveToolConfig().Tools[toolName]
	return ok
}

// ToolModels returns the model IDs declared for a tool in active available tools.
func ToolModels(toolName string) ([]string, bool) {
	cfg := effectiveToolConfig()
	tool, ok := cfg.Tools[strings.TrimSpace(toolName)]
	if !ok {
		return nil, false
	}
	return append([]string(nil), tool.Models...), true
}

// ModelsForTool returns models for a tool from active tool definitions.
func ModelsForTool(toolName string) []string {
	if models, ok := ToolModels(toolName); ok {
		return models
	}
	return nil
}

// AvailableTools returns tool names from active available tools.
func AvailableTools() []string {
	cfg := effectiveToolConfig()
	names := make([]string, 0, len(cfg.Tools))
	for name := range cfg.Tools {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ToolDefinition returns a tool definition from active available tools.
func ToolDefinition(toolName string) (toolcfg.Tool, bool) {
	toolName = strings.TrimSpace(toolName)
	if toolName == "" {
		return toolcfg.Tool{}, false
	}
	tool, ok := effectiveToolConfig().Tools[toolName]
	return tool, ok
}
