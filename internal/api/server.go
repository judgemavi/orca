package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/ops"
	"github.com/jasjeetmavi/orca/internal/orchestrator"
	"github.com/jasjeetmavi/orca/internal/pty"
	"github.com/jasjeetmavi/orca/internal/sprint"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
)

// Server is the Orca HTTP/WS API server.
type Server struct {
	db         *state.DB
	cfg        *config.Config
	planner    *sprint.Planner
	executor   *sprint.Executor
	ops        *ops.Store
	repoDir    string
	hub        *Hub
	sessionMgr *pty.SessionManager
	ctx        context.Context
	cancel     context.CancelFunc

	monitorAlerts []MonitorAlert
	monitorMu     sync.Mutex

	// Embedded frontend filesystem (optional).
	frontendFS fs.FS
}

// NewServer creates a Server and starts the WebSocket hub.
// frontendFS is optional — pass nil to disable static file serving.
func NewServer(db *state.DB, cfg *config.Config, planner *sprint.Planner, executor *sprint.Executor, repoDir string, frontendFS fs.FS, sessionMgr *pty.SessionManager) *Server {
	return NewServerWithHub(db, cfg, planner, executor, repoDir, frontendFS, sessionMgr, nil)
}

// NewServerWithHub creates a Server with an optional pre-created hub.
// If hub is nil, a new hub is created and started.
func NewServerWithHub(db *state.DB, cfg *config.Config, planner *sprint.Planner, executor *sprint.Executor, repoDir string, frontendFS fs.FS, sessionMgr *pty.SessionManager, hub *Hub) *Server {
	if hub == nil {
		hub = NewHub()
		go hub.Run()
	}
	ctx, cancel := context.WithCancel(context.Background())
	taskStore := task.NewStore(db)
	opsStore := ops.NewStore(db)
	watcher := state.NewWatcher(db, state.WatcherCallbacks{
		OnTaskChange: func(changes []state.TaskChange) {
			for _, c := range changes {
				switch c.Type {
				case state.ChangeCreated:
					t, err := taskStore.Get(c.TaskID)
					if err == nil {
						hub.Broadcast(Event{Type: "task.created", Data: t})
					}
				case state.ChangeUpdated:
					t, err := taskStore.Get(c.TaskID)
					if err == nil {
						hub.Broadcast(Event{Type: "task.updated", Data: t})
					}
				case state.ChangeDeleted:
					hub.Broadcast(Event{Type: "task.deleted", Data: map[string]string{"id": c.TaskID}})
				}
			}
		},
		OnSprintChange: func(changes []state.SprintChange) {
			for _, c := range changes {
				if c.Type == state.ChangeCreated || c.Type == state.ChangeUpdated || c.Type == state.ChangeDeleted {
					sp, err := planner.Get(c.SprintID)
					if err == nil {
						hub.Broadcast(Event{Type: "sprint.updated", Data: sp})
						continue
					}
					hub.Broadcast(Event{Type: "sprint.updated", Data: map[string]string{"id": c.SprintID}})
				}
			}
		},
		OnOperationChange: func(changes []state.OperationChange) {
			for _, c := range changes {
				op, err := opsStore.Get(c.OperationID)
				if err == nil {
					hub.Broadcast(Event{Type: "operation.updated", Data: op})
					continue
				}
				hub.Broadcast(Event{Type: "operation.updated", Data: map[string]string{"id": c.OperationID}})
			}
		},
		OnSessionChange: func(changes []state.SessionChange) {
			for _, c := range changes {
				row := db.QueryRow(
					`SELECT id, type, tool, task_id, status, exit_code FROM sessions WHERE id = ?`,
					c.SessionID,
				)
				var (
					id       string
					typ      string
					toolName string
					taskID   sql.NullString
					status   string
					exitCode int
				)
				if err := row.Scan(&id, &typ, &toolName, &taskID, &status, &exitCode); err != nil {
					continue
				}
				taskIDValue := ""
				if taskID.Valid {
					taskIDValue = taskID.String
				}

				switch c.Type {
				case state.ChangeCreated:
					hub.Broadcast(Event{
						Type: "session.created",
						Data: map[string]interface{}{
							"id":        id,
							"type":      typ,
							"tool":      toolName,
							"task_id":   taskIDValue,
							"status":    status,
							"exit_code": exitCode,
						},
					})
				case state.ChangeUpdated:
					if status == "exited" {
						hub.Broadcast(Event{
							Type: "session.exited",
							Data: map[string]interface{}{
								"id":        id,
								"type":      typ,
								"tool":      toolName,
								"task_id":   taskIDValue,
								"status":    status,
								"exit_code": exitCode,
							},
						})
					}
				}
			}
		},
	}, state.WatcherOpts{})
	go watcher.Run(ctx)

	if err := opsStore.MarkStaleAsFailed(); err != nil {
		log.Printf("mark stale operations failed: %v", err)
	}

	planner.SetEventHook(func(eventType string, id string) {
		hub.Broadcast(Event{Type: eventType, Data: map[string]string{"id": id}})
	})

	if sessionMgr != nil {
		sessionMgr.SetEventHook(func(eventType string, sess *pty.Session) {
			hub.Broadcast(Event{
				Type: eventType,
				Data: map[string]interface{}{
					"id":        sess.ID,
					"type":      string(sess.Type),
					"tool":      sess.Tool,
					"task_id":   sess.TaskID,
					"exit_code": sess.ExitCode,
				},
			})
		})
	}

	srv := &Server{
		db:         db,
		cfg:        cfg,
		planner:    planner,
		executor:   executor,
		ops:        opsStore,
		repoDir:    repoDir,
		hub:        hub,
		frontendFS: frontendFS,
		sessionMgr: sessionMgr,
		ctx:        ctx,
		cancel:     cancel,
	}

	if executor != nil {
		executor.SetMonitorAlertHook(func(alertType, taskID, message string) {
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

// Routes returns the HTTP handler with all API routes and middleware.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Tasks
	mux.HandleFunc("/api/v1/tasks", s.routeTasks)
	mux.HandleFunc("/api/v1/tasks/ready", s.handleGetReady)
	mux.HandleFunc("/api/v1/tasks/", s.routeTaskByID)
	mux.HandleFunc("/api/v1/models", s.handleListModels)
	mux.HandleFunc("/api/v1/cleanup", s.handleCleanup)

	// Sprints
	mux.HandleFunc("/api/v1/sprints", s.routeSprints)
	mux.HandleFunc("/api/v1/sprints/active", s.handleGetActiveSprint)
	mux.HandleFunc("/api/v1/sprints/plan", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.handlePlanSprint(w, r)
	})
	mux.HandleFunc("/api/v1/sprints/assign", s.handleSprintAssign)
	mux.HandleFunc("/api/v1/sprints/unassign", s.handleSprintUnassign)
	mux.HandleFunc("/api/v1/sprints/", s.routeSprintByID)

	// Integrate
	mux.HandleFunc("/api/v1/integrate", s.handleIntegrate)

	// Explore
	mux.HandleFunc("/api/v1/explore", s.handleExplore)
	mux.HandleFunc("/api/v1/explore/context", s.routeExploreContext)

	// Plan
	mux.HandleFunc("/api/v1/plan", s.handlePlan)
	mux.HandleFunc("/api/v1/plan/accept", s.handlePlanAccept)
	mux.HandleFunc("/api/v1/plan/reject", s.handlePlanReject)
	mux.HandleFunc("/api/v1/operations", s.handleListOperations)

	// Costs, Config, Status
	mux.HandleFunc("/api/v1/costs", s.handleCosts)
	mux.HandleFunc("/api/v1/config", s.routeConfig)
	mux.HandleFunc("/api/v1/status", s.handleStatus)
	mux.HandleFunc("/api/v1/monitor/alerts", s.handleMonitorAlerts)

	// WebSocket
	mux.HandleFunc("/api/v1/ws", s.hub.ServeWS)
	mux.HandleFunc("/api/v1/terminal/", s.handleTerminalWS)

	// Sessions
	mux.HandleFunc("/api/v1/sessions", s.routeSessions)
	mux.HandleFunc("/api/v1/sessions/", s.routeSessionByID)

	// Orchestrator
	mux.HandleFunc("/api/v1/orchestrator/start", s.handleStartOrchestrator)

	// Frontend served under /ui/ with SPA fallback for client-side routing.
	if s.frontendFS != nil {
		fileServer := http.FileServer(http.FS(s.frontendFS))
		mux.Handle("/ui/", http.StripPrefix("/ui/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Try serving the file directly first.
			path := r.URL.Path
			if path == "" || path == "/" {
				path = "index.html"
			}
			f, err := s.frontendFS.Open(path)
			if err == nil {
				f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
			// SPA fallback: serve index.html for unknown paths.
			r.URL.Path = "/"
			fileServer.ServeHTTP(w, r)
		})))
		// Redirect bare /ui to /ui/
		mux.HandleFunc("/ui", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/ui/", http.StatusMovedPermanently)
		})
	}

	return logMiddleware(corsMiddleware(mux))
}

// BootstrapOrchestrator starts the orchestrator PTY session for orca serve.
func (s *Server) BootstrapOrchestrator() {
	if s.sessionMgr == nil {
		return
	}

	orcaBinary, err := os.Executable()
	if err != nil {
		log.Printf("resolve orca binary: %v", err)
		return
	}

	mcpConfigPath, err := orchestrator.WriteMCPConfig(s.repoDir, orcaBinary, s.cfg.Tools)
	if err != nil {
		log.Printf("write mcp config: %v", err)
		return
	}

	toolName, supervisorTool, err := orchestrator.ResolveSupervisorTool(s.cfg)
	if err != nil {
		log.Printf("resolve supervisor tool: %v", err)
		return
	}
	if strings.TrimSpace(supervisorTool.Binary) == "" {
		log.Printf("resolve supervisor tool: tool %q has empty binary", toolName)
		return
	}

	args := orchestrator.BuildLaunchArgs(supervisorTool, mcpConfigPath)
	sess, err := s.sessionMgr.Create(pty.CreateOpts{
		Type:    pty.SessionOrchestrator,
		Command: supervisorTool.Binary,
		Args:    args,
		Dir:     s.repoDir,
		Tool:    "orchestrator",
		Cols:    120,
		Rows:    40,
		Env:     []string{"ORCA_MCP_CONFIG=" + mcpConfigPath},
	})
	if err != nil {
		log.Printf("bootstrap orchestrator: %v", err)
		return
	}

	log.Printf("orchestrator session started (%s): %s", toolName, sess.ID)
}

// --- routing helpers ---

func (s *Server) routeTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleListTasks(w, r)
	case http.MethodPost:
		s.handleCreateTask(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) routeTaskByID(w http.ResponseWriter, r *http.Request) {
	id := extractPathParam(r.URL.Path, "/api/v1/tasks/")
	if id == "" {
		jsonError(w, "missing task id", http.StatusBadRequest)
		return
	}

	parts := strings.Split(id, "/")
	taskID := parts[0]
	if taskID == "" {
		jsonError(w, "missing task id", http.StatusBadRequest)
		return
	}

	if len(parts) > 1 {
		switch parts[1] {
		case "deps":
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			s.handleAddDep(w, r, taskID)
		case "merge":
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			s.handleMergeTask(w, r, taskID)
		case "reopen":
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			s.handleReopenTask(w, r, taskID)
		case "approve":
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			s.handleApproveTask(w, r, taskID)
		case "request-changes":
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			s.handleRequestChanges(w, r, taskID)
		case "reviews":
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			s.handleListTaskReviews(w, r, taskID)
		case "plan":
			if len(parts) == 2 {
				switch r.Method {
				case http.MethodGet:
					s.handleGetTaskPlan(w, r, taskID)
				case http.MethodPut:
					s.handlePutTaskPlan(w, r, taskID)
				default:
					http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				}
				return
			}
			if len(parts) == 3 && parts[2] == "generate" {
				s.handleGenerateTaskPlan(w, r, taskID)
				return
			}
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.handleGetTask(w, r, taskID)
	case http.MethodPatch:
		s.handleUpdateTask(w, r, taskID)
	case http.MethodDelete:
		s.handleDeleteTask(w, r, taskID)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) routeSprints(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleListSprints(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) routeSprintByID(w http.ResponseWriter, r *http.Request) {
	id := extractPathParam(r.URL.Path, "/api/v1/sprints/")
	if id == "" {
		jsonError(w, "missing sprint id", http.StatusBadRequest)
		return
	}

	parts := strings.SplitN(id, "/", 2)
	if len(parts) == 2 {
		switch parts[1] {
		case "start":
			s.handleStartSprint(w, r, parts[0])
		case "cancel":
			s.handleCancelSprint(w, r, parts[0])
		case "reset":
			s.handleResetSprint(w, r, parts[0])
		case "review":
			s.routeSprintReview(w, r, parts[0])
		case "plan":
			s.handlePlanSprint(w, r)
		default:
			http.NotFound(w, r)
		}
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.handleGetSprint(w, r, id)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) routeSprintReview(w http.ResponseWriter, r *http.Request, sprintID string) {
	switch r.Method {
	case http.MethodGet:
		s.handleGetReview(w, r, sprintID)
	case http.MethodPost:
		s.handlePostReview(w, r, sprintID)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) routeExploreContext(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleGetContext(w, r)
	case http.MethodPut:
		s.handlePutContext(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) routeConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleGetConfig(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// --- utility functions ---

func extractPathParam(path, prefix string) string {
	return strings.TrimPrefix(path, prefix)
}

func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func jsonOK(w http.ResponseWriter, data interface{}) {
	jsonResponse(w, http.StatusOK, map[string]interface{}{"data": data})
}

func jsonError(w http.ResponseWriter, msg interface{}, code int) {
	errStr := ""
	switch v := msg.(type) {
	case string:
		errStr = v
	case error:
		errStr = v.Error()
	default:
		errStr = "unknown error"
	}
	jsonResponse(w, code, map[string]interface{}{"error": errStr})
}

func jsonResponse(w http.ResponseWriter, code int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(payload)
}
