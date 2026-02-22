package pty

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
)

// SessionType identifies the role of a PTY session.
type SessionType string

const (
	SessionOrchestrator SessionType = "orchestrator"
	SessionWorker       SessionType = "worker"
)

// Session owns one PTY process and its metadata.
type Session struct {
	ID        string
	Type      SessionType
	Cmd       *exec.Cmd
	Pty       *os.File
	Dir       string
	Tool      string
	TaskID    string
	Cols      uint16
	Rows      uint16
	CreatedAt time.Time
	ExitCode  int
	mu        sync.Mutex
	exited    chan struct{}
	eventOnce sync.Once
	closeOnce sync.Once
}

// CreateOpts defines inputs for creating a PTY session.
type CreateOpts struct {
	Type    SessionType
	Command string
	Args    []string
	Dir     string
	Env     []string
	Tool    string
	TaskID  string
	Cols    uint16
	Rows    uint16
}

// Manager tracks all active PTY sessions.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	onEvent  func(eventType string, session *Session)
}

// NewManager creates a PTY session manager.
func NewManager() *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
	}
}

// SetEventHook configures a callback fired on lifecycle events.
func (m *Manager) SetEventHook(fn func(string, *Session)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onEvent = fn
}

// Create starts a new PTY session and returns it once running.
func (m *Manager) Create(opts CreateOpts) (*Session, error) {
	if strings.TrimSpace(opts.Command) == "" {
		return nil, fmt.Errorf("command is required")
	}

	cols := opts.Cols
	if cols == 0 {
		cols = 80
	}
	rows := opts.Rows
	if rows == 0 {
		rows = 24
	}

	cmd := exec.Command(opts.Command, opts.Args...)
	if opts.Dir != "" {
		cmd.Dir = opts.Dir
	}
	cmd.Env = mergeEnv(filteredEnv(), opts.Env)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		return nil, fmt.Errorf("start pty: %w", err)
	}

	s := &Session{
		ID:        uuid.NewString(),
		Type:      opts.Type,
		Cmd:       cmd,
		Pty:       ptmx,
		Dir:       opts.Dir,
		Tool:      opts.Tool,
		TaskID:    opts.TaskID,
		Cols:      cols,
		Rows:      rows,
		CreatedAt: time.Now().UTC(),
		ExitCode:  -1,
		exited:    make(chan struct{}),
	}

	m.mu.Lock()
	m.sessions[s.ID] = s
	hook := m.onEvent
	m.mu.Unlock()

	if hook != nil {
		hook("session.created", s)
	}

	go m.waitForExit(s)

	return s, nil
}

// Get returns a session by ID, or nil when not found.
func (m *Manager) Get(id string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[id]
}

// List returns all active sessions.
func (m *Manager) List() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}
	return out
}

// Kill terminates a session via SIGTERM then SIGKILL after 5s if needed.
func (m *Manager) Kill(id string) error {
	s := m.Get(id)
	if s == nil {
		return fmt.Errorf("session %q not found", id)
	}

	if s.Cmd != nil && s.Cmd.Process != nil {
		if err := s.Cmd.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return fmt.Errorf("sigterm %q: %w", id, err)
		}
	}

	go func(sess *Session) {
		select {
		case <-sess.exited:
			return
		case <-time.After(5 * time.Second):
		}
		if sess.Cmd != nil && sess.Cmd.Process != nil {
			_ = sess.Cmd.Process.Kill()
		}
	}(s)

	m.finalizeSession(s)
	return nil
}

// Resize updates PTY window dimensions.
func (m *Manager) Resize(id string, cols, rows uint16) error {
	s := m.Get(id)
	if s == nil {
		return fmt.Errorf("session %q not found", id)
	}
	if cols == 0 || rows == 0 {
		return fmt.Errorf("invalid size cols=%d rows=%d", cols, rows)
	}
	if err := pty.Setsize(s.Pty, &pty.Winsize{Rows: rows, Cols: cols}); err != nil {
		return fmt.Errorf("resize %q: %w", id, err)
	}

	s.mu.Lock()
	s.Cols = cols
	s.Rows = rows
	s.mu.Unlock()

	return nil
}

// Write sends bytes to session PTY stdin.
func (m *Manager) Write(id string, data []byte) (int, error) {
	s := m.Get(id)
	if s == nil {
		return 0, fmt.Errorf("session %q not found", id)
	}
	return s.Pty.Write(data)
}

// Reader returns the PTY master reader.
func (m *Manager) Reader(id string) (io.Reader, error) {
	s := m.Get(id)
	if s == nil {
		return nil, fmt.Errorf("session %q not found", id)
	}
	return s.Pty, nil
}

// Cleanup terminates all active sessions.
func (m *Manager) Cleanup() {
	for _, s := range m.List() {
		_ = m.Kill(s.ID)
	}
}

func (m *Manager) waitForExit(s *Session) {
	err := s.Cmd.Wait()

	s.mu.Lock()
	if s.ExitCode == -1 {
		s.ExitCode = exitCodeFromWaitErr(err)
	}
	s.mu.Unlock()

	close(s.exited)
	m.finalizeSession(s)
}

func (m *Manager) finalizeSession(s *Session) {
	s.closeOnce.Do(func() {
		if s.Pty != nil {
			_ = s.Pty.Close()
		}
	})

	m.mu.Lock()
	delete(m.sessions, s.ID)
	hook := m.onEvent
	m.mu.Unlock()

	s.eventOnce.Do(func() {
		if hook != nil {
			hook("session.exited", s)
		}
	})
}

func exitCodeFromWaitErr(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

func filteredEnv() []string {
	env := make([]string, 0, len(os.Environ()))
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "CLAUDECODE=") {
			env = append(env, e)
		}
	}
	return env
}

func mergeEnv(base, extra []string) []string {
	if len(extra) == 0 {
		return base
	}

	out := append([]string{}, base...)
	pos := make(map[string]int, len(out))
	for i, kv := range out {
		k := envKey(kv)
		if k != "" {
			pos[k] = i
		}
	}

	for _, kv := range extra {
		k := envKey(kv)
		if k == "" {
			out = append(out, kv)
			continue
		}
		if i, ok := pos[k]; ok {
			out[i] = kv
			continue
		}
		pos[k] = len(out)
		out = append(out, kv)
	}

	return out
}

func envKey(kv string) string {
	if kv == "" {
		return ""
	}
	i := strings.IndexByte(kv, '=')
	if i <= 0 {
		return ""
	}
	return kv[:i]
}
