package interaction

import (
	"os"
	"sync"
)

// Writer writes interaction log output.
type Writer struct {
	id   string
	file *os.File
	mu   sync.Mutex
}

func (w *Writer) ID() string {
	return w.id
}

func (w *Writer) WriteString(s string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, err := w.file.WriteString(s)
	return err
}

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
