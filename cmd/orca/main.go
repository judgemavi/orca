package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/jasjeetmavi/orca/cmd/orca/commands"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/cost"
	"github.com/jasjeetmavi/orca/internal/logging"
	"github.com/jasjeetmavi/orca/internal/sprint"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

const skipRuntimeInitAnnotation = "orca.skip_runtime_init"

type runtimeState struct {
	db       *state.DB
	cfg      *config.Config
	store    *task.Store
	planner  *sprint.Planner
	executor *sprint.Executor
}

func (rt *runtimeState) init() error {
	if rt.db != nil && rt.cfg != nil && rt.store != nil && rt.planner != nil && rt.executor != nil {
		return nil
	}
	dbPath := filepath.Join(".orca", "state.db")
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		return fmt.Errorf("orca not initialized — run 'orca init' first")
	}
	db, err := state.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	cfg, err := config.Load(filepath.Join(".orca", "orca.yaml"))
	if err != nil {
		db.Close()
		return fmt.Errorf("load config: %w", err)
	}
	repoDir, err := os.Getwd()
	if err != nil {
		db.Close()
		return fmt.Errorf("get working directory: %w", err)
	}
	wm := worktree.NewManager(repoDir, cfg.Project.WorktreeDir)
	rt.db = db
	rt.cfg = cfg
	rt.store = task.NewStore(db)
	rt.planner = sprint.NewPlanner(db)
	rt.executor = sprint.NewExecutor(rt.planner, wm, cfg, repoDir, sprint.ExecutorOptions{CostTracker: cost.NewTracker(db)})
	slog.Info("runtime.initialized", "db_path", dbPath)
	return nil
}

func (rt *runtimeState) close() {
	if rt.db != nil {
		_ = rt.db.Close()
	}
	rt.db, rt.cfg, rt.store, rt.planner, rt.executor = nil, nil, nil, nil, nil
}

func (rt *runtimeState) openStore() (*state.DB, *task.Store, error) {
	if err := rt.init(); err != nil {
		return nil, nil, err
	}
	return rt.db, rt.store, nil
}

func (rt *runtimeState) loadRuntime() (*state.DB, *config.Config, *sprint.Planner, *sprint.Executor, error) {
	if err := rt.init(); err != nil {
		return nil, nil, nil, nil, err
	}
	return rt.db, rt.cfg, rt.planner, rt.executor, nil
}

func markSkipRuntimeInit(cmd *cobra.Command) {
	if cmd.Annotations == nil {
		cmd.Annotations = map[string]string{}
	}
	cmd.Annotations[skipRuntimeInitAnnotation] = "true"
}

func shouldSkipRuntimeInit(cmd *cobra.Command) bool {
	if cmd == nil || cmd.Name() == "help" || cmd.Name() == "completion" {
		return true
	}
	for c := cmd; c != nil; c = c.Parent() {
		if c.Annotations[skipRuntimeInitAnnotation] == "true" {
			return true
		}
	}
	return false
}

func main() {
	rt := &runtimeState{}
	reg := commands.NewRegistry(rt.openStore, rt.loadRuntime)
	var loggingCleanup func()

	root := &cobra.Command{Use: "orca", Short: "Multi-agent CLI orchestrator"}
	root.PersistentPreRunE = func(cmd *cobra.Command, args []string) error {
		logCfg := logging.DefaultConfig()
		configPath := filepath.Join(".orca", "orca.yaml")
		data, err := os.ReadFile(configPath)
		if err == nil {
			var parsed struct {
				Logging logging.Config `yaml:"logging"`
			}
			if unmarshalErr := yaml.Unmarshal(data, &parsed); unmarshalErr == nil {
				if strings.TrimSpace(parsed.Logging.Level) != "" {
					logCfg.Level = parsed.Logging.Level
				}
				if strings.TrimSpace(parsed.Logging.File) != "" {
					logCfg.File = parsed.Logging.File
				}
				if strings.TrimSpace(parsed.Logging.MaxSize) != "" {
					logCfg.MaxSize = parsed.Logging.MaxSize
				}
			}
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("read logging config: %w", err)
		}

		cleanup, err := logging.Init(logCfg)
		if err != nil {
			return fmt.Errorf("init logging: %w", err)
		}
		loggingCleanup = cleanup
		slog.Info("orca command start", "cmd", cmd.CommandPath(), "args", args)

		if shouldSkipRuntimeInit(cmd) {
			return nil
		}
		if err := rt.init(); err != nil {
			if loggingCleanup != nil {
				loggingCleanup()
				loggingCleanup = nil
			}
			return err
		}
		return nil
	}
	root.PersistentPostRun = func(cmd *cobra.Command, args []string) {
		rt.close()
		if loggingCleanup != nil {
			loggingCleanup()
			loggingCleanup = nil
		}
	}

	commands.RegisterMisc(root, reg, commands.MiscOptions{MarkSkipRuntimeInit: markSkipRuntimeInit})
	commands.RegisterExplore(root, reg)
	commands.RegisterPlan(root, reg)
	commands.RegisterRun(root, reg)
	commands.RegisterBacklog(root, reg)
	commands.RegisterSprint(root, reg)
	commands.RegisterReview(root, reg)
	commands.RegisterIntegrate(root, reg)
	commands.RegisterServe(root, reg)
	commands.RegisterMCP(root, reg)

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}
