package commands

import (
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/state"
)

func newConfiguredMemorySyncer(cfg *config.Config, store *memory.Store, db *state.DB, repoDir string) *memory.Syncer {
	if cfg != nil {
		if toolName, d, err := cfg.ResolveToolForPhase(interaction.PhaseExplore, ""); err == nil {
			model := cfg.ResolveModelForPhase(interaction.PhaseExplore, "", d)
			return memory.NewSyncer(store, db.DB, repoDir, toolName, d, model, 2*time.Minute)
		}
	}
	return memory.NewSyncer(store, db.DB, repoDir, "", nil, "", 2*time.Minute)
}
