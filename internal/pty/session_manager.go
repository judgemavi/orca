package pty

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jasjeetmavi/pod/internal/state"
)

// SessionRow is a persisted session record from the backing store.
type SessionRow struct {
	ID        string
	Type      SessionType
	Tool      string
	TaskID    string
	PID       int
	Dir       string
	Cols      uint16
	Rows      uint16
	Status    string
	ExitCode  int
	CreatedAt time.Time
	ExitedAt  *time.Time
}

// SessionManager owns the PTY + persistence lifecycle for sessions.
type SessionManager struct {
	runtime  *Manager
	db       *state.DB
	mu       sync.RWMutex
	onEvent  func(string, *Session)
	shutdown bool
}

// NewSessionManager creates a lifecycle manager with DB as source of truth.
func NewSessionManager(db *state.DB) *SessionManager {
	sm := &SessionManager{
		runtime: NewManager(),
		db:      db,
	}
	sm.runtime.SetEventHook(sm.handleRuntimeEvent)
	return sm
}

// SetEventHook configures a callback fired on session lifecycle events.
func (m *SessionManager) SetEventHook(fn func(string, *Session)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onEvent = fn
}

// Reconcile marks stale DB sessions as exited during server startup.
func (m *SessionManager) Reconcile() (int, error) {
	if m.db == nil {
		return 0, nil
	}
	return m.db.MarkStaleSessions()
}

// Create starts a PTY session and persists it. On persistence failure, the PTY is torn down.
func (m *SessionManager) Create(opts CreateOpts) (*Session, error) {
	s, err := m.runtime.Create(opts)
	if err != nil {
		return nil, err
	}

	if m.db != nil {
		if err := m.db.InsertSession(s.ID, string(s.Type), s.Tool, s.TaskID, s.Cmd.Process.Pid, s.Dir, int(s.Cols), int(s.Rows)); err != nil {
			_ = m.runtime.Kill(s.ID)
			return nil, fmt.Errorf("persist session %s: %w", s.ID, err)
		}
	}

	m.emitEvent("session.created", s)

	return s, nil
}

// Kill terminates a PTY session and marks it exited in DB.
func (m *SessionManager) Kill(id string) error {
	s := m.runtime.Get(id)
	if s == nil {
		return fmt.Errorf("session %q not found", id)
	}

	if err := m.runtime.Kill(id); err != nil {
		return err
	}
	if m.db != nil {
		if err := m.db.MarkSessionExited(id, s.ExitCode); err != nil {
			return fmt.Errorf("persist session exit %s: %w", id, err)
		}
	}

	return nil
}

// Get returns the active runtime session by ID.
func (m *SessionManager) Get(id string) *Session {
	return m.runtime.Get(id)
}

// Write sends bytes to PTY stdin.
func (m *SessionManager) Write(id string, data []byte) (int, error) {
	return m.runtime.Write(id, data)
}

// Resize updates PTY dimensions.
func (m *SessionManager) Resize(id string, cols, rows uint16) error {
	return m.runtime.Resize(id, cols, rows)
}

// Cleanup terminates all active runtime sessions.
func (m *SessionManager) Cleanup() {
	m.mu.Lock()
	if m.shutdown {
		m.mu.Unlock()
		return
	}
	m.shutdown = true
	m.mu.Unlock()
	m.runtime.Cleanup()
}

// ListActive returns sessions from DB (single source of truth).
func (m *SessionManager) ListActive() ([]SessionRow, error) {
	if m.db == nil {
		return nil, nil
	}
	rows, err := m.db.ListActiveSessions()
	if err != nil {
		return nil, err
	}

	out := make([]SessionRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, SessionRow{
			ID:        row.ID,
			Type:      SessionType(row.Type),
			Tool:      row.Tool,
			TaskID:    row.TaskID,
			PID:       row.PID,
			Dir:       row.Dir,
			Cols:      uint16(row.Cols),
			Rows:      uint16(row.Rows),
			Status:    row.Status,
			ExitCode:  row.ExitCode,
			CreatedAt: row.CreatedAt,
			ExitedAt:  row.ExitedAt,
		})
	}
	return out, nil
}

func (m *SessionManager) handleRuntimeEvent(eventType string, session *Session) {
	if eventType == "session.created" {
		return
	}
	if m.db != nil && eventType == "session.exited" {
		if err := m.db.MarkSessionExited(session.ID, session.ExitCode); err != nil {
			log.Printf("persist session exit %s: %v", session.ID, err)
		}
	}

	m.emitEvent(eventType, session)
}

func (m *SessionManager) emitEvent(eventType string, session *Session) {
	m.mu.RLock()
	hook := m.onEvent
	m.mu.RUnlock()

	if hook != nil {
		hook(eventType, session)
	}
}
