package api

import (
	"time"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/toolcfg"
)

func (s *Server) newMemorySyncer(store *memory.Store) *memory.Syncer {
	if store == nil {
		store = s.memoryStore
	}
	if store == nil || s.db == nil {
		return memory.NewSyncer(store, nil, s.repoDir, "", toolcfg.Tool{}, "", 2*time.Minute)
	}
	if s.cfg != nil {
		if toolName, tool, err := s.cfg.ResolveToolForPhase(interaction.PhaseExplore, ""); err == nil {
			model := s.cfg.ResolveModelForPhase(interaction.PhaseExplore, "", toolName)
			return memory.NewSyncer(store, s.db.DB, s.repoDir, toolName, tool, model, 2*time.Minute)
		}
	}
	return memory.NewSyncer(store, s.db.DB, s.repoDir, "", toolcfg.Tool{}, "", 2*time.Minute)
}
