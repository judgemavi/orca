package api

import (
	"context"
	"io/fs"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/orchestrator"
	"github.com/jasjeetmavi/orca/internal/pty"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
)

// Server is the Orca HTTP/WS API server.
type Server struct {
	db           *state.DB
	cfg          *config.Config
	executor     *executor.Executor
	taskStore    *task.Store
	memoryStore  *memory.Store
	interactions *interaction.Store
	repoDir      string
	hub          *Hub
	sessionMgr   *pty.SessionManager
	ctx          context.Context
	cancel       context.CancelFunc

	monitorAlerts []MonitorAlert
	monitorMu     sync.Mutex

	// Embedded frontend filesystem (optional).
	frontendFS fs.FS
}

// NewServerWithHub creates a Server with an optional pre-created hub.
// If hub is nil, a new hub is created and started.
func NewServerWithHub(db *state.DB, cfg *config.Config, exec *executor.Executor, repoDir string, frontendFS fs.FS, sessionMgr *pty.SessionManager, hub *Hub) *Server {
	if hub == nil {
		hub = NewHub()
		go hub.Run()
	}
	ctx, cancel := context.WithCancel(context.Background())
	taskStore := task.NewStore(db)
	memoryStore := memory.NewStore(db)
	interactionStore := interaction.NewStore(db, ".orca/interactions")

	srv := &Server{
		db:           db,
		cfg:          cfg,
		executor:     exec,
		taskStore:    taskStore,
		memoryStore:  memoryStore,
		interactions: interactionStore,
		repoDir:      repoDir,
		hub:          hub,
		frontendFS:   frontendFS,
		sessionMgr:   sessionMgr,
		ctx:          ctx,
		cancel:       cancel,
	}

	srv.setupWatchers(ctx, taskStore)

	if exec != nil {
		exec.SetMonitorAlertHook(func(alertType, taskID, message string) {
			srv.AddMonitorAlert(MonitorAlert{
				Type:      alertType,
				TaskID:    taskID,
				Message:   message,
				Timestamp: time.Now().UTC(),
			})
		})
	}

	return srv
}

// Shutdown stops background server workers.
func (s *Server) Shutdown() {
	if s.cancel != nil {
		s.cancel()
	}
}

// LogStarted records server startup once listener bind succeeds.
func (s *Server) LogStarted(addr string) {
	slog.Info("server.started", "addr", addr)
}

// BootstrapOrchestrator starts the orchestrator PTY session for orca serve.
func (s *Server) BootstrapOrchestrator() {
	if s.sessionMgr == nil {
		return
	}

	orcaBinary, err := os.Executable()
	if err != nil {
		slog.Error("resolve orca binary failed", "err", err)
		return
	}

	mcpConfigPath, err := orchestrator.WriteMCPConfig(s.repoDir, orcaBinary, s.cfg.Tools)
	if err != nil {
		slog.Error("write mcp config failed", "err", err)
		return
	}

	toolName, supervisorTool, model, err := orchestrator.ResolveSupervisorTool(s.cfg)
	if err != nil {
		slog.Error("resolve supervisor tool failed", "err", err)
		return
	}
	if supervisorTool == nil || strings.TrimSpace(supervisorTool.Binary()) == "" {
		slog.Error("resolve supervisor tool binary empty", "tool", toolName)
		return
	}

	args := orchestrator.BuildLaunchArgs(supervisorTool, model, mcpConfigPath)
	sess, err := s.sessionMgr.Create(pty.CreateOpts{
		Type:    pty.SessionOrchestrator,
		Command: supervisorTool.Binary(),
		Args:    args,
		Dir:     s.repoDir,
		Tool:    "orchestrator",
		Cols:    120,
		Rows:    40,
		Env:     []string{"ORCA_MCP_CONFIG=" + mcpConfigPath},
	})
	if err != nil {
		slog.Error("bootstrap orchestrator failed", "tool", toolName, "err", err)
		return
	}

	slog.Info("orchestrator session started", "tool", toolName, "session_id", sess.ID)
}
