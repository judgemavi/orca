package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/mcp"
	"github.com/jasjeetmavi/orca/internal/sprint"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
)

func main() {
	repoDir, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "get working directory: %v\n", err)
		os.Exit(1)
	}

	dbPath := filepath.Join(repoDir, ".orca", "state.db")
	db, err := state.Open(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open database: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	cfgPath := filepath.Join(repoDir, ".orca", "orca.yaml")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			defaultCfg, defaultErr := config.Default()
			if defaultErr != nil {
				fmt.Fprintf(os.Stderr, "load default config: %v\n", defaultErr)
				os.Exit(1)
			}
			cfg = &defaultCfg
		} else {
			fmt.Fprintf(os.Stderr, "load config: %v\n", err)
			os.Exit(1)
		}
	}

	store := task.NewStore(db)
	planner := sprint.NewPlanner(db)
	wm := worktree.NewManager(repoDir, cfg.Project.WorktreeDir)
	executor := sprint.NewExecutor(planner, wm, cfg, repoDir, sprint.ExecutorOptions{})

	server := mcp.NewServer(store, planner, executor, cfg, repoDir)
	if err := server.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "mcp server: %v\n", err)
		os.Exit(1)
	}
}
