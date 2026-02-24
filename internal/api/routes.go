package api

import (
	"net/http"
	"strings"
)

// Routes returns the HTTP handler with all API routes and middleware.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Tasks
	mux.HandleFunc("/api/v1/tasks", s.routeTasks)
	mux.HandleFunc("/api/v1/tasks/ready", s.handleGetReady)
	mux.HandleFunc("/api/v1/tasks/run", s.handleRunTasks)
	mux.HandleFunc("/api/v1/tasks/", s.routeTaskByID)
	mux.HandleFunc("/api/tasks/", s.routeTaskByID)
	mux.HandleFunc("/api/v1/models", s.handleListModels)
	mux.HandleFunc("/api/v1/cleanup", s.handleCleanup)

	// Merge
	mux.HandleFunc("/api/v1/merge", s.handleMerge)

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
	if id == r.URL.Path {
		id = extractPathParam(r.URL.Path, "/api/tasks/")
	}
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
		case "evaluate":
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			s.handleEvaluateTask(w, r, taskID)
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

func extractPathParam(path, prefix string) string {
	return strings.TrimPrefix(path, prefix)
}
