// Package logging configures structured application logging.
package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

const (
	defaultLevel   = "info"
	defaultFile    = ".orca/orca.log"
	defaultMaxSize = "50mb"
)

var maxSizePattern = regexp.MustCompile(`^\s*(\d+)\s*([kmgt]?b)?\s*$`)

// Config controls slog output level and file rotation settings.
type Config struct {
	Level   string `yaml:"level"`
	File    string `yaml:"file"`
	MaxSize string `yaml:"max_size"`
}

// DefaultConfig returns conservative defaults for local log files.
func DefaultConfig() Config {
	return Config{
		Level:   defaultLevel,
		File:    defaultFile,
		MaxSize: defaultMaxSize,
	}
}

// Init configures slog with JSON output and a rotating file writer.
func Init(cfg Config) error {
	if strings.TrimSpace(cfg.Level) == "" {
		cfg.Level = defaultLevel
	}
	if strings.TrimSpace(cfg.File) == "" {
		cfg.File = defaultFile
	}
	if strings.TrimSpace(cfg.MaxSize) == "" {
		cfg.MaxSize = defaultMaxSize
	}

	level, err := parseLevel(cfg.Level)
	if err != nil {
		return fmt.Errorf("parse log level: %w", err)
	}

	maxSize, err := ParseMaxSize(cfg.MaxSize)
	if err != nil {
		return fmt.Errorf("parse max_size: %w", err)
	}

	writer, err := NewRotatingWriter(cfg.File, maxSize)
	if err != nil {
		return fmt.Errorf("create log writer: %w", err)
	}

	handler := slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: level})
	slog.SetDefault(slog.New(handler))
	return nil
}

func parseLevel(level string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("unsupported level %q", level)
	}
}

// ParseMaxSize parses size strings like "50mb", "512kb", or "4096".
func ParseMaxSize(raw string) (int64, error) {
	match := maxSizePattern.FindStringSubmatch(strings.ToLower(raw))
	if len(match) != 3 {
		return 0, fmt.Errorf("invalid size %q", raw)
	}

	n, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse number: %w", err)
	}
	if n <= 0 {
		return 0, fmt.Errorf("size must be > 0")
	}

	multiplier := int64(1)
	switch match[2] {
	case "", "b":
		multiplier = 1
	case "kb":
		multiplier = 1024
	case "mb":
		multiplier = 1024 * 1024
	case "gb":
		multiplier = 1024 * 1024 * 1024
	case "tb":
		multiplier = 1024 * 1024 * 1024 * 1024
	default:
		return 0, fmt.Errorf("unsupported unit %q", match[2])
	}

	return n * multiplier, nil
}

var _ io.Writer = (*RotatingWriter)(nil)

// RotatingWriter writes to file and rotates to "<file>.1" once max size reached.
type RotatingWriter struct {
	mu       sync.Mutex
	path     string
	maxSize  int64
	file     *os.File
	currSize int64
}

// NewRotatingWriter creates a writer that appends to path and rotates at maxSize.
func NewRotatingWriter(path string, maxSize int64) (*RotatingWriter, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("path required")
	}
	if maxSize <= 0 {
		return nil, fmt.Errorf("max size must be > 0")
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, fmt.Errorf("create log dir: %w", err)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("open log file: %w", err)
	}

	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("stat log file: %w", err)
	}

	return &RotatingWriter{
		path:     path,
		maxSize:  maxSize,
		file:     f,
		currSize: stat.Size(),
	}, nil
}

func (w *RotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.file == nil {
		return 0, fmt.Errorf("writer closed")
	}

	if w.currSize > 0 && w.currSize+int64(len(p)) > w.maxSize {
		if err := w.rotateLocked(); err != nil {
			return 0, err
		}
	}

	n, err := w.file.Write(p)
	w.currSize += int64(n)
	return n, err
}

// Close closes the underlying file.
func (w *RotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

func (w *RotatingWriter) rotateLocked() error {
	if err := w.file.Close(); err != nil {
		return fmt.Errorf("close log file: %w", err)
	}

	rotated := w.path + ".1"
	if err := os.Remove(rotated); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove rotated file: %w", err)
	}
	if err := os.Rename(w.path, rotated); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("rotate log file: %w", err)
	}

	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("open new log file: %w", err)
	}

	w.file = f
	w.currSize = 0
	return nil
}
