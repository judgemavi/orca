package api

import (
	"net/http"
)

// Routes returns the HTTP handler with all API routes and middleware.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Tasks
	mux.HandleFunc("GET /api/v1/tasks", s.handleListTasks)
	mux.HandleFunc("POST /api/v1/tasks", s.handleCreateTask)
	mux.HandleFunc("GET /api/v1/tasks/ready", s.handleGetReady)
	mux.HandleFunc("POST /api/v1/tasks/start", s.handleRunTasks)
	mux.HandleFunc("GET /api/v1/tasks/{id}", s.handleGetTask)
	mux.HandleFunc("PATCH /api/v1/tasks/{id}", s.handleUpdateTask)
	mux.HandleFunc("DELETE /api/v1/tasks/{id}", s.handleDeleteTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/deps", s.handleAddDep)
	mux.HandleFunc("POST /api/v1/tasks/{id}/merge", s.handleMergeTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/stop", s.handleStopTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/cancel", s.handleStopTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/resume", s.handleResumeTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/approve", s.handleApproveTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/approve-plan", s.handleApprovePlan)
	mux.HandleFunc("POST /api/v1/tasks/{id}/request-changes", s.handleRequestChanges)
	mux.HandleFunc("POST /api/v1/tasks/{id}/request-plan-changes", s.handleRequestPlanChanges)
	mux.HandleFunc("GET /api/v1/tasks/{id}/reviews", s.handleListTaskReviews)
	mux.HandleFunc("GET /api/v1/tasks/{id}/interactions", s.handleListInteractions)
	mux.HandleFunc("GET /api/v1/tasks/{id}/interactions/{interactionID}", s.handleGetInteraction)
	mux.HandleFunc("GET /api/v1/tasks/{id}/interactions/{interactionID}/stream", s.handleStreamInteraction)
	mux.HandleFunc("GET /api/v1/tasks/{id}/plan", s.handleGetTaskPlan)
	mux.HandleFunc("PUT /api/v1/tasks/{id}/plan", s.handlePutTaskPlan)
	mux.HandleFunc("POST /api/v1/tasks/{id}/plan/generate", s.handleGenerateTaskPlan)
	mux.HandleFunc("POST /api/v1/tasks/{id}/evaluate", s.handleEvaluateTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/breakdown", s.handleBreakdownTask)
	mux.HandleFunc("POST /api/v1/tasks/{id}/breakdown/accept", s.handleAcceptBreakdown)
	mux.HandleFunc("POST /api/v1/tasks/{id}/breakdown/reject", s.handleRejectBreakdown)
	mux.HandleFunc("POST /api/v1/tasks/{id}/ai-review", s.handleAIReview)
	mux.HandleFunc("POST /api/v1/tasks/{id}/retro", s.handleRetroTask)

	// Memory
	mux.HandleFunc("GET /api/v1/memory", s.handleListMemory)
	mux.HandleFunc("GET /api/v1/memory/{id}", s.handleGetMemory)
	mux.HandleFunc("PATCH /api/v1/memory/{id}", s.handleUpdateMemory)
	mux.HandleFunc("DELETE /api/v1/memory/{id}", s.handleDeleteMemory)
	mux.HandleFunc("POST /api/v1/memory/sync", s.handleSyncMemory)

	mux.HandleFunc("GET /api/v1/models", s.handleListModels)
	mux.HandleFunc("POST /api/v1/cleanup", s.handleCleanup)

	// Merge
	mux.HandleFunc("POST /api/v1/merge", s.handleMerge)

	// Explore
	mux.HandleFunc("POST /api/v1/explore", s.handleExplore)
	mux.HandleFunc("GET /api/v1/explore/context", s.handleGetContext)
	mux.HandleFunc("PUT /api/v1/explore/context", s.handlePutContext)

	// Plan
	mux.HandleFunc("POST /api/v1/plan", s.handlePlan)
	mux.HandleFunc("POST /api/v1/plan/accept", s.handlePlanAccept)
	mux.HandleFunc("POST /api/v1/plan/reject", s.handlePlanReject)
	mux.HandleFunc("GET /api/v1/operations", s.handleListRunningInteractions)

	// Costs, Config, Status
	mux.HandleFunc("GET /api/v1/costs", s.handleCosts)
	mux.HandleFunc("GET /api/v1/config", s.handleGetConfig)
	mux.HandleFunc("PUT /api/v1/config", s.handleUpdateConfig)
	mux.HandleFunc("GET /api/v1/status", s.handleStatus)
	mux.HandleFunc("GET /api/v1/monitor/alerts", s.handleMonitorAlerts)

	// WebSocket
	mux.HandleFunc("GET /api/v1/ws", s.hub.ServeWS)
	mux.HandleFunc("GET /api/v1/terminal/{sessionID}", s.handleTerminalWS)

	// Sessions
	mux.HandleFunc("GET /api/v1/sessions", s.handleListSessions)
	mux.HandleFunc("POST /api/v1/sessions", s.handleCreateSession)
	mux.HandleFunc("DELETE /api/v1/sessions/{sessionID}", s.handleKillSession)

	// Orchestrator
	mux.HandleFunc("POST /api/v1/orchestrator/start", s.handleStartOrchestrator)

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
