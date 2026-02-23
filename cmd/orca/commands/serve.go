package commands

import (
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"

	"github.com/jasjeetmavi/orca/internal/api"
	"github.com/jasjeetmavi/orca/internal/banner"
	"github.com/jasjeetmavi/orca/internal/cost"
	"github.com/jasjeetmavi/orca/internal/pty"
	"github.com/jasjeetmavi/orca/internal/sprint"
	"github.com/jasjeetmavi/orca/internal/worktree"
	"github.com/jasjeetmavi/orca/web"
	"github.com/spf13/cobra"
)

func RegisterServe(root *cobra.Command, r *Registry) {
	serveCmd := &cobra.Command{Use: "serve", Short: "Start the Orca web server", RunE: r.runServe}
	serveCmd.Flags().String("addr", "", "Listen address (overrides config)")
	root.AddCommand(serveCmd)
}

func (r *Registry) runServe(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := r.loadRuntimeOrErr()
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
		fmt.Fprintf(os.Stderr, "mark stale sessions: %v\n", err)
	} else if n > 0 {
		fmt.Fprintf(os.Stderr, "marked %d stale sessions as exited\n", n)
	}
	defer sessionMgr.Cleanup()

	hub := api.NewHub()
	go hub.Run()

	opts := api.NewExecutorOptions(db, hub)
	opts.CostTracker = cost.NewTracker(db)
	wm := worktree.NewManager(repoDir, cfg.Project.WorktreeDir)
	executor := sprint.NewExecutor(planner, wm, cfg, repoDir, opts, sessionMgr)
	srv := api.NewServerWithHub(db, cfg, planner, executor, repoDir, frontendFS, sessionMgr, hub)
	defer srv.Shutdown()

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	defer ln.Close()

	banner.Print()
	fmt.Printf("Orca server listening on %s\n", addr)
	srv.BootstrapOrchestrator()
	return http.Serve(ln, srv.Routes())
}
