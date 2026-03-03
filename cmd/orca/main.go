package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/jasjeetmavi/orca/cmd/orca/commands"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/logging"
	"github.com/jasjeetmavi/orca/internal/pty"
	"github.com/jasjeetmavi/orca/internal/recovery"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
	"github.com/spf13/cobra"
)

const skipRuntimeInitAnnotation = "orca.skip_runtime_init"

type runtimeState struct {
	ctx          context.Context
	db           *state.DB
	cfg          *config.Config
	store        *task.Store
	interactions *interaction.Store
	sessionMgr   *pty.SessionManager
	executor     *executor.Executor
	shutdownOnce sync.Once
}

func (rt *runtimeState) init() error {
	if rt.db != nil && rt.cfg != nil && rt.store != nil && rt.interactions != nil && rt.sessionMgr != nil && rt.executor != nil {
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

	repoDir, err := os.Getwd()
	if err != nil {
		db.Close()
		return fmt.Errorf("get working directory: %w", err)
	}
	if _, toolConfigPath, err := config.LoadToolConfigForRepo(repoDir); err != nil {
		db.Close()
		return fmt.Errorf("load tool config: %w", err)
	} else if toolConfigPath != "" {
		slog.Info("tool config loaded", "path", toolConfigPath)
	}

	cfg, err := config.LoadFromDB(db.DB)
	if err != nil {
		db.Close()
		return fmt.Errorf("load config: %w", err)
	}
	activeTools := config.AvailableToolConfig()
	changes := cfg.SanitizeOrchestrator(activeTools)
	if err := cfg.ValidateDefaults(activeTools); err != nil {
		db.Close()
		return fmt.Errorf("validate default tool/model: %w", err)
	}
	if len(changes) > 0 {
		for _, change := range changes {
			slog.Warn("config sanitized", "change", change)
		}
		if err := cfg.SaveToDB(db.DB); err != nil {
			db.Close()
			return fmt.Errorf("persist sanitized config: %w", err)
		}
	}
	if err := cfg.Validate(); err != nil {
		db.Close()
		return fmt.Errorf("validate config: %w", err)
	}
	wm := worktree.NewManager(repoDir, cfg.Project.WorktreeDir)
	taskStore := task.NewStore(db)
	interactionStore := interaction.NewStore(db, ".orca/interactions")
	sessionMgr := pty.NewSessionManager(db)
	if err := recovery.Recover(db, taskStore, interactionStore, sessionMgr); err != nil {
		db.Close()
		return fmt.Errorf("startup recovery: %w", err)
	}
	rt.db = db
	rt.cfg = cfg
	rt.store = taskStore
	rt.interactions = interactionStore
	rt.sessionMgr = sessionMgr
	parentCtx := rt.ctx
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	rt.executor = executor.NewExecutor(parentCtx, db, rt.store, wm, cfg, repoDir, executor.ExecutorOptions{Interactions: interactionStore})
	slog.Info("runtime.initialized", "db_path", dbPath)
	return nil
}

func (rt *runtimeState) close() {
	rt.shutdown()
}

func (rt *runtimeState) shutdown() {
	rt.shutdownOnce.Do(func() {
		if rt.store != nil && rt.interactions != nil {
			runFailed, otherFailed, err := recovery.FailInFlightForShutdown(rt.store, rt.interactions)
			if err != nil {
				slog.Warn("runtime.shutdown.recover_inflight_failed", "err", err)
			} else if runFailed > 0 || otherFailed > 0 {
				slog.Info("runtime.shutdown.inflight_recovered", "run_failed", runFailed, "other_failed", otherFailed)
			}
		}

		if rt.sessionMgr != nil {
			rt.sessionMgr.Cleanup()
		}
		if rt.db != nil {
			_ = rt.db.Close()
		}
		rt.db, rt.cfg, rt.store, rt.interactions, rt.sessionMgr, rt.executor = nil, nil, nil, nil, nil, nil
	})
}

func (rt *runtimeState) openStore() (*state.DB, *task.Store, error) {
	if err := rt.init(); err != nil {
		return nil, nil, err
	}
	return rt.db, rt.store, nil
}

func (rt *runtimeState) loadRuntime() (*state.DB, *config.Config, *executor.Executor, error) {
	if err := rt.init(); err != nil {
		return nil, nil, nil, err
	}
	return rt.db, rt.cfg, rt.executor, nil
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
	appCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	rt := &runtimeState{ctx: appCtx}
	reg := commands.NewRegistry(rt.openStore, rt.loadRuntime)
	var loggingCleanup func()
	cleanup := func() {
		rt.close()
		if loggingCleanup != nil {
			loggingCleanup()
			loggingCleanup = nil
		}
	}

	root := &cobra.Command{Use: "orca", Short: "Multi-agent CLI orchestrator"}
	root.PersistentPreRunE = func(cmd *cobra.Command, args []string) error {
		logCfg := logging.DefaultConfig()
		skipRuntime := shouldSkipRuntimeInit(cmd)
		if !skipRuntime {
			if err := rt.init(); err != nil {
				return err
			}
			if rt.cfg != nil {
				logCfg = rt.cfg.Logging
			}
		}

		cleanup, err := logging.Init(logCfg)
		if err != nil {
			return fmt.Errorf("init logging: %w", err)
		}
		loggingCleanup = cleanup
		slog.Info("orca command start", "cmd", cmd.CommandPath(), "args", args)

		if skipRuntime {
			return nil
		}
		return nil
	}
	root.PersistentPostRun = func(cmd *cobra.Command, args []string) {
		cleanup()
	}

	commands.RegisterMisc(root, reg, commands.MiscOptions{MarkSkipRuntimeInit: markSkipRuntimeInit})
	commands.RegisterExplore(root, reg)
	commands.RegisterPlan(root, reg)
	commands.RegisterStart(root, reg)
	commands.RegisterTask(root, reg)
	commands.RegisterMemory(root, reg)
	commands.RegisterReview(root, reg)
	commands.RegisterMerge(root, reg)
	commands.RegisterServe(root, reg)
	commands.RegisterMCP(root, reg)

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)
	go func() {
		firstSig, ok := <-sigCh
		if !ok {
			return
		}
		slog.Warn("shutdown.signal_received", "signal", firstSig.String(), "step", "graceful")
		cancel()
		rt.shutdown()

		secondSig, ok := <-sigCh
		if !ok {
			return
		}
		slog.Error("shutdown.signal_received", "signal", secondSig.String(), "step", "force_exit")
		os.Exit(1)
	}()

	if err := root.ExecuteContext(appCtx); err != nil {
		cleanup()
		os.Exit(1)
	}
}
