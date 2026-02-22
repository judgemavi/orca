package commands

import (
	"fmt"
	"os"

	"github.com/jasjeetmavi/orca/internal/mcp"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func RegisterMCP(root *cobra.Command, r *Registry) {
	mcpCmd := &cobra.Command{Use: "mcp", Short: "Run Orca MCP server (stdio)", RunE: r.runMCP}
	root.AddCommand(mcpCmd)
}

func (r *Registry) runMCP(cmd *cobra.Command, args []string) error {
	db, cfg, planner, executor, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	store := task.NewStore(db)
	server := mcp.NewServer(store, planner, executor, cfg, repoDir)
	if err := server.Run(); err != nil {
		return fmt.Errorf("mcp server: %w", err)
	}
	return nil
}
