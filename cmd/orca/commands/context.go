package commands

import (
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
)

// Registry provides shared runtime dependencies to command handlers.
type Registry struct {
	openStore   func() (*state.DB, *task.Store, error)
	loadRuntime func() (*state.DB, *config.Config, *executor.Executor, error)
}

func NewRegistry(
	openStore func() (*state.DB, *task.Store, error),
	loadRuntime func() (*state.DB, *config.Config, *executor.Executor, error),
) *Registry {
	return &Registry{openStore: openStore, loadRuntime: loadRuntime}
}

func (r *Registry) openStoreOrErr() (*state.DB, *task.Store, error) {
	return r.openStore()
}

func (r *Registry) loadRuntimeOrErr() (*state.DB, *config.Config, *executor.Executor, error) {
	return r.loadRuntime()
}
