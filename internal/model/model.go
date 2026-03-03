// Package model provides model listing from tool drivers.
package model

import (
	"github.com/jasjeetmavi/orca/internal/config"
)

// Model describes a model available for a tool.
type Model struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
}

// ForTool returns models for a tool name from loaded or bundled toolcfg.
func ForTool(toolName string) ([]Model, bool) {
	ids := config.ModelsForTool(toolName)
	if len(ids) == 0 {
		return nil, false
	}
	models := make([]Model, 0, len(ids))
	for _, id := range ids {
		models = append(models, Model{ID: id, Name: id, Provider: toolName})
	}
	return models, true
}

// AllFromConfig returns models for every configured tool, keyed by tool name.
func AllFromConfig(cfg *config.Config) map[string][]Model {
	result := make(map[string][]Model, len(cfg.Tools))
	for _, name := range cfg.Tools {
		models, ok := ForTool(name)
		if !ok {
			continue
		}
		result[name] = models
	}
	return result
}
