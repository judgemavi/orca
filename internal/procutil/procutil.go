package procutil

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// StreamOptions configures line streaming from a reader.
type StreamOptions struct {
	TaskID   string
	Stream   string
	Reader   io.Reader
	Buffer   *bytes.Buffer
	EmitLine func(taskID, stream, line string, ts time.Time)
	OnError  func(error)
}

// Stream reads newline-delimited chunks from Reader, optionally appends raw bytes
// to Buffer, emits normalized UTF-8 lines via callback, and returns any non-EOF error.
func Stream(opts StreamOptions) error {
	reader := bufio.NewReader(opts.Reader)
	for {
		chunk, err := reader.ReadBytes('\n')
		if len(chunk) > 0 {
			if opts.Buffer != nil {
				opts.Buffer.Write(chunk)
			}
			if opts.EmitLine != nil {
				line := strings.ToValidUTF8(strings.TrimRight(string(chunk), "\r\n"), "?")
				opts.EmitLine(opts.TaskID, opts.Stream, line, time.Now().UTC())
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			if opts.OnError != nil {
				opts.OnError(err)
			}
			return err
		}
	}
}

// LoadContextFromWorktree returns .orca/context.md from worktree, or empty string.
func LoadContextFromWorktree(worktreePath string) string {
	data, err := os.ReadFile(filepath.Join(worktreePath, ".orca", "context.md"))
	if err != nil {
		return ""
	}
	return string(data)
}

// GitOutput runs a git command in dir and returns stdout.
func GitOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
