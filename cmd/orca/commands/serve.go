package commands

import (
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"

	"github.com/jasjeetmavi/orca/internal/api"
	"github.com/jasjeetmavi/orca/internal/banner"
	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/pty"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
	"github.com/jasjeetmavi/orca/web"
	"github.com/spf13/cobra"
)

func RegisterServe(root *cobra.Command, r *Registry) {
	serveCmd := &cobra.Command{Use: "serve", Short: "Start the Orca web server", RunE: r.runServe}
	serveCmd.Flags().String("addr", "", "Listen address (overrides config)")
	serveCmd.Flags().Bool("orchestrator", false, "Auto-start the orchestrator agent")
	root.AddCommand(serveCmd)
}

func (r *Registry) runServe(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	repoDir, _ := os.Getwd()

	addr, _ := cmd.Flags().GetString("addr")
	if addr == "" {
		addr = cfg.Server.Addr
	}
	if addr == "" {
		addr = ":8080"
	}

	var frontendFS fs.FS
	if sub, err := fs.Sub(web.DistFS, "dist"); err == nil {
		frontendFS = sub
	}

	sessionMgr := pty.NewSessionManager(db)
	if n, err := sessionMgr.Reconcile(); err != nil {
		warnf("mark stale sessions: %v", err)
	} else if n > 0 {
		warnf("marked %d stale sessions as exited", n)
	}
	defer sessionMgr.Cleanup()

	hub := api.NewHub()
	go hub.Run()

	opts := api.NewExecutorOptions(db, hub)
	opts.Interactions = interaction.NewStore(db, ".orca/interactions")
	store := task.NewStore(db)
	wm := worktree.NewManager(repoDir, cfg.Project.WorktreeDir)
	exec := executor.NewExecutor(db, store, wm, cfg, repoDir, opts, sessionMgr)
	srv := api.NewServerWithHub(db, cfg, exec, repoDir, frontendFS, sessionMgr, hub)
	defer srv.Shutdown()

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	defer ln.Close()
	srv.LogStarted(addr)

	banner.Print()
	fmt.Printf("Orca server listening on %s\n", addr)
	if startOrch, _ := cmd.Flags().GetBool("orchestrator"); startOrch {
		srv.BootstrapOrchestrator()
	}
	return http.Serve(ln, srv.Routes())
}
