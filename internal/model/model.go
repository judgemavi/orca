// Package model provides model listing from tool drivers.
package model

import (
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/driver"
)

// Model describes a model available for a tool.
type Model struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
}

// FromDriver returns the model list for a tool driver.
func FromDriver(toolName string, d driver.Driver) []Model {
	ids := d.Models()
	models := make([]Model, 0, len(ids))
	for _, id := range ids {
		models = append(models, Model{ID: id, Name: id, Provider: toolName})
	}
	return models
}

// AllFromConfig returns models for every configured tool, keyed by tool name.
func AllFromConfig(cfg *config.Config) map[string][]Model {
	result := make(map[string][]Model, len(cfg.Tools))
	for _, name := range cfg.Tools {
		d, ok := driver.Get(name)
		if !ok {
			continue
		}
		result[name] = FromDriver(name, d)
	}
	return result
}
