package commands

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"time"

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
	serveCmd.Flags().IntP("port", "p", 8080, "Port to listen on")
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

	port, _ := cmd.Flags().GetInt("port")
	addr := fmt.Sprintf(":%d", port)

	var frontendFS fs.FS
	if sub, err := fs.Sub(web.DistFS, "dist"); err == nil {
		frontendFS = sub
	}

	sessionMgr := pty.NewSessionManager(db)
	defer sessionMgr.Cleanup()

	hub := api.NewHub()
	go hub.Run()

	opts := api.NewExecutorOptions(db, hub)
	opts.Interactions = interaction.NewStore(db, ".orca/interactions")
	store := task.NewStore(db)
	wm := worktree.NewManager(repoDir, cfg.Project.WorktreeDir)
	parentCtx := cmd.Context()
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	exec := executor.NewExecutor(parentCtx, db, store, wm, cfg, repoDir, opts, sessionMgr)
	srv := api.NewServerWithHub(db, cfg, exec, repoDir, frontendFS, sessionMgr, hub)
	defer srv.Shutdown()

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	defer ln.Close()
	httpSrv := &http.Server{Handler: srv.Routes()}
	go func() {
		<-parentCtx.Done()
		srv.Shutdown()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	srv.LogStarted(addr)

	banner.Print()
	fmt.Printf("Orca server listening on %s\n", addr)
	if startOrch, _ := cmd.Flags().GetBool("orchestrator"); startOrch {
		srv.BootstrapOrchestrator()
	}
	err = httpSrv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) && parentCtx.Err() != nil {
		return nil
	}
	if err != nil {
		return fmt.Errorf("serve http: %w", err)
	}
	return nil
}
