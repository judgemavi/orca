package pty

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
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
	ID         string
	Type       SessionType
	Cmd        *exec.Cmd
	Pty        *os.File
	Scrollback *Scrollback
	Dir        string
	Tool       string
	TaskID     string
	Cols       uint16
	Rows       uint16
	CreatedAt  time.Time
	ExitCode   int
	mu         sync.Mutex
	exited     chan struct{}
	eventOnce  sync.Once
	closeOnce  sync.Once
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

	command, args := resolveCommand(opts.Command, opts.Args)
	env := mergeEnv(filteredEnv(), opts.Env)
	ws := &pty.Winsize{Rows: rows, Cols: cols}

	cmd := exec.Command(command, args...)
	if opts.Dir != "" {
		cmd.Dir = opts.Dir
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = env

	ptmx, err := pty.StartWithSize(cmd, ws)
	if err != nil {
		// macOS may block Setpgid for certain binaries (e.g. nvm-installed node).
		// Retry without process group creation — Kill will target the process directly.
		slog.Debug("pty Setpgid failed, retrying without process group", "command", opts.Command, "err", err)
		cmd = exec.Command(command, args...)
		if opts.Dir != "" {
			cmd.Dir = opts.Dir
		}
		cmd.Env = env
		ptmx, err = pty.StartWithSize(cmd, ws)
		if err != nil {
			return nil, fmt.Errorf("start pty: %w", err)
		}
	}

	s := &Session{
		ID:         uuid.NewString(),
		Type:       opts.Type,
		Cmd:        cmd,
		Pty:        ptmx,
		Scrollback: NewScrollback(256 * 1024),
		Dir:        opts.Dir,
		Tool:       opts.Tool,
		TaskID:     opts.TaskID,
		Cols:       cols,
		Rows:       rows,
		CreatedAt:  time.Now().UTC(),
		ExitCode:   -1,
		exited:     make(chan struct{}),
	}

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				_, _ = s.Scrollback.Write(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()

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

// Kill terminates a session process group via SIGTERM then SIGKILL after 5s.
func (m *Manager) Kill(id string) error {
	s := m.Get(id)
	if s == nil {
		return fmt.Errorf("session %q not found", id)
	}

	if err := signalProcessGroup(s, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.EPERM) {
			slog.Warn("pty permission denied sending SIGTERM", "session_id", id, "pid", processID(s), "err", err)
		} else {
			return fmt.Errorf("sigterm %q: %w", id, err)
		}
	}

	if waitForExit(s, 5*time.Second) {
		return nil
	}

	if err := signalProcessGroup(s, syscall.SIGKILL); err != nil {
		if errors.Is(err, syscall.EPERM) {
			slog.Warn("pty permission denied sending SIGKILL", "session_id", id, "pid", processID(s), "err", err)
		} else {
			slog.Warn("pty failed sending SIGKILL", "session_id", id, "pid", processID(s), "err", err)
		}
	}

	waitForExit(s, 5*time.Second)
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
		if s.Scrollback != nil {
			s.Scrollback.Close()
		}
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

func signalProcessGroup(s *Session, sig syscall.Signal) error {
	if s == nil || s.Cmd == nil || s.Cmd.Process == nil {
		return nil
	}

	pid := s.Cmd.Process.Pid

	// Try process group first (works when Setpgid was used).
	if err := syscall.Kill(-pid, sig); err == nil {
		return nil
	}

	// Fallback: signal the process directly (Setpgid wasn't set or pgid not found).
	err := syscall.Kill(pid, sig)
	if err == nil {
		return nil
	}
	if errors.Is(err, syscall.ESRCH) || errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

func waitForExit(s *Session, timeout time.Duration) bool {
	if s == nil {
		return true
	}
	select {
	case <-s.exited:
		return true
	case <-time.After(timeout):
		return false
	}
}

func processID(s *Session) int {
	if s == nil || s.Cmd == nil || s.Cmd.Process == nil {
		return 0
	}
	return s.Cmd.Process.Pid
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

// resolveCommand detects shebang scripts and returns the interpreter + script
// as the command so that fork/exec targets a real binary. This avoids macOS
// "operation not permitted" errors when execve hits a quarantined script via
// PTY with Setpgid.
func resolveCommand(command string, args []string) (string, []string) {
	path, err := exec.LookPath(command)
	if err != nil {
		return command, args
	}

	// Follow symlinks to the real file.
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		real = path
	}

	f, err := os.Open(real)
	if err != nil {
		return command, args
	}
	defer f.Close()

	buf := make([]byte, 256)
	n, err := f.Read(buf)
	if err != nil || n < 4 || string(buf[:2]) != "#!" {
		return command, args
	}

	line := string(buf[2:n])
	if idx := strings.IndexByte(line, '\n'); idx >= 0 {
		line = line[:idx]
	}
	line = strings.TrimSpace(line)

	// Handle "#!/usr/bin/env node" style shebangs.
	parts := strings.Fields(line)
	if len(parts) == 0 {
		return command, args
	}

	interp := parts[len(parts)-1] // e.g. "node" from "/usr/bin/env node"
	if filepath.Base(parts[0]) == "env" && len(parts) > 1 {
		interp = parts[1]
	}

	interpPath, err := exec.LookPath(interp)
	if err != nil {
		return command, args
	}

	return interpPath, append([]string{real}, args...)
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
