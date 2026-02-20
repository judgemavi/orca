package api

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/ops"
	"github.com/jasjeetmavi/pod/internal/sprint"
	"github.com/jasjeetmavi/pod/internal/state"
	"github.com/jasjeetmavi/pod/internal/worker"
)

// Server is the Pod HTTP/WS API server.
type Server struct {
	db       *state.DB
	cfg      *config.Config
	planner  *sprint.Planner
	executor *sprint.Executor
	ops      *ops.Store
	repoDir  string
	hub      *Hub
	resolver *IntentResolver

	// Channel for autopilot respond unblocking.
	autopilotResp   chan bool
	autopilotMu     sync.Mutex
	autopilotCancel func() // set when autopilot is running

	// Embedded frontend filesystem (optional).
	frontendFS fs.FS
}

// NewServer creates a Server and starts the WebSocket hub.
// frontendFS is optional — pass nil to disable static file serving.
func NewServer(db *state.DB, cfg *config.Config, planner *sprint.Planner, executor *sprint.Executor, repoDir string, frontendFS fs.FS) *Server {
	hub := NewHub()
	go hub.Run()
	opsStore := ops.NewStore(db)
	if err := opsStore.MarkStaleAsFailed(); err != nil {
		log.Printf("mark stale operations failed: %v", err)
	}

	planner.SetEventHook(func(eventType string, id string) {
		hub.Broadcast(Event{Type: eventType, Data: map[string]string{"id": id}})
	})

	var toolCfg config.ToolConfig
	for _, tc := range cfg.Tools {
		toolCfg = tc
		break
	}

	executor.SetOutputHook(func(line worker.OutputLine) {
		hub.Broadcast(Event{
			Type: "worker.output",
			Data: map[string]interface{}{
				"task_id": line.TaskID,
				"stream":  line.Stream,
				"line":    line.Line,
				"ts":      line.Time.UTC().Format(time.RFC3339Nano),
			},
		})
	})
	executor.SetDoneHook(func(taskID string, exitCode int) {
		hub.Broadcast(Event{
			Type: "worker.done",
			Data: map[string]interface{}{
				"task_id":   taskID,
				"exit_code": exitCode,
			},
		})
		hub.Broadcast(Event{
			Type: "worker.output.end",
			Data: map[string]interface{}{
				"task_id": taskID,
				"ts":      time.Now().UTC().Format(time.RFC3339Nano),
			},
		})
	})

	return &Server{
		db:         db,
		cfg:        cfg,
		planner:    planner,
		executor:   executor,
		ops:        opsStore,
		repoDir:    repoDir,
		hub:        hub,
		resolver:   NewIntentResolver(toolCfg, repoDir),
		frontendFS: frontendFS,
	}
}

// Routes returns the HTTP handler with all API routes and middleware.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Tasks
	mux.HandleFunc("/api/v1/tasks", s.routeTasks)
	mux.HandleFunc("/api/v1/tasks/ready", s.handleGetReady)
	mux.HandleFunc("/api/v1/tasks/", s.routeTaskByID)
	mux.HandleFunc("/api/v1/logs", s.handleListLogs)
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

	// Autopilot
	mux.HandleFunc("/api/v1/autopilot/start", s.handleAutopilotStart)
	mux.HandleFunc("/api/v1/autopilot/stop", s.handleAutopilotStop)
	mux.HandleFunc("/api/v1/autopilot/respond", s.handleAutopilotRespond)
	mux.HandleFunc("/api/v1/autopilot/status", s.handleAutopilotStatus)

	// Costs, Config, Status
	mux.HandleFunc("/api/v1/costs", s.handleCosts)
	mux.HandleFunc("/api/v1/config", s.routeConfig)
	mux.HandleFunc("/api/v1/status", s.handleStatus)

	// Chat & WebSocket
	mux.HandleFunc("/api/v1/chat", s.handleChat)
	mux.HandleFunc("/api/v1/ws", s.hub.ServeWS)

	// Static files for frontend (embedded)
	if s.frontendFS != nil {
		mux.Handle("/", http.FileServer(http.FS(s.frontendFS)))
	}

	return logMiddleware(corsMiddleware(mux))
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
		case "logs":
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			s.handleGetTaskLogs(w, r, taskID)
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
	case http.MethodPatch:
		s.handlePatchConfig(w, r)
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
