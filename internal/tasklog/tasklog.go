package tasklog

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const maxTaskLogBytes int64 = 10 * 1024 * 1024

// Path returns the on-disk log file path for a task.
func Path(repoDir, taskID string) string {
	return filepath.Join(repoDir, ".pod", "logs", taskID+".log")
}

// EnsureDir ensures .pod/logs exists.
func EnsureDir(repoDir string) error {
	return os.MkdirAll(filepath.Join(repoDir, ".pod", "logs"), 0755)
}

// Writer appends prefixed log lines to a per-task file with a size cap.
type Writer struct {
	mu   sync.Mutex
	file *os.File
	size int64
}

// NewWriter opens/creates the task log file.
func NewWriter(repoDir, taskID string) (*Writer, error) {
	if err := EnsureDir(repoDir); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(Path(repoDir, taskID), os.O_CREATE|os.O_RDWR|os.O_APPEND, 0644)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return &Writer{file: f, size: st.Size()}, nil
}

// WriteLine writes one normalized line.
func (w *Writer) WriteLine(stream, line string) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	normalized := strings.ToValidUTF8(strings.TrimRight(line, "\r\n"), "?")
	entry := fmt.Sprintf("[%s] %s\n", stream, normalized)
	entryBytes := []byte(entry)

	if int64(len(entryBytes)) >= maxTaskLogBytes {
		entryBytes = entryBytes[len(entryBytes)-int(maxTaskLogBytes)+1:]
	}
	if w.size+int64(len(entryBytes)) > maxTaskLogBytes {
		if err := w.file.Truncate(0); err != nil {
			return err
		}
		if _, err := w.file.Seek(0, io.SeekStart); err != nil {
			return err
		}
		w.size = 0
	}

	n, err := w.file.Write(entryBytes)
	w.size += int64(n)
	return err
}

// Close closes the file.
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

// ReadLines reads all lines in the task log.
func ReadLines(repoDir, taskID string) ([]string, error) {
	f, err := os.Open(Path(repoDir, taskID))
	if err != nil {
		return nil, err
	}
	defer f.Close()

	lines := make([]string, 0, 256)
	s := bufio.NewScanner(f)
	buf := make([]byte, 0, 64*1024)
	s.Buffer(buf, 1024*1024)
	for s.Scan() {
		lines = append(lines, strings.ToValidUTF8(s.Text(), "?"))
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

// ReadTailLines reads the last n lines. If n <= 0, all lines are returned.
func ReadTailLines(repoDir, taskID string, n int) ([]string, error) {
	if n <= 0 {
		return ReadLines(repoDir, taskID)
	}

	f, err := os.Open(Path(repoDir, taskID))
	if err != nil {
		return nil, err
	}
	defer f.Close()

	buf := make([]string, n)
	count := 0
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for s.Scan() {
		buf[count%n] = strings.ToValidUTF8(s.Text(), "?")
		count++
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	if count == 0 {
		return []string{}, nil
	}
	if count < n {
		return append([]string(nil), buf[:count]...), nil
	}
	out := make([]string, 0, n)
	start := count % n
	out = append(out, buf[start:]...)
	out = append(out, buf[:start]...)
	return out, nil
}

// ReadLastLine reads only the most recent line.
func ReadLastLine(repoDir, taskID string) (string, error) {
	f, err := os.Open(Path(repoDir, taskID))
	if err != nil {
		return "", err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	if st.Size() == 0 {
		return "", nil
	}

	const window = int64(8 * 1024)
	start := st.Size() - window
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return "", err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return "", err
	}
	parts := bytes.Split(bytes.TrimRight(data, "\n"), []byte("\n"))
	if len(parts) == 0 {
		return "", nil
	}
	return strings.ToValidUTF8(string(parts[len(parts)-1]), "?"), nil
}
