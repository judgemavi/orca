// Package model provides model listing from tool configuration.
package model

import (
	"github.com/jasjeetmavi/pod/internal/config"
)

// Model describes a model available for a tool.
type Model struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
}

// FromConfig returns the model list for a tool based on its config.
// The tool name is used as the provider.
func FromConfig(toolName string, toolCfg config.ToolConfig) []Model {
	models := make([]Model, 0, len(toolCfg.Models))
	for _, id := range toolCfg.Models {
		models = append(models, Model{
			ID:       id,
			Name:     id,
			Provider: toolName,
		})
	}
	return models
}

// AllFromConfig returns models for every tool in the config, keyed by tool name.
func AllFromConfig(cfg *config.Config) map[string][]Model {
	result := make(map[string][]Model, len(cfg.Tools))
	for name, tc := range cfg.Tools {
		result[name] = FromConfig(name, tc)
	}
	return result
}
