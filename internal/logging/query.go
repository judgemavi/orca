package logging

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Filter defines optional constraints for querying JSONL log entries.
type Filter struct {
	Level   string
	TaskID  string
	Since   time.Time
	Pattern string
	Limit   int
}

// Entry is a single log line parsed from ndjson.
type Entry struct {
	Time  time.Time      `json:"time"`
	Level string         `json:"level"`
	Msg   string         `json:"msg"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

// Query reads an ndjson log file, applies filters, and returns matching entries.
func Query(logPath string, filter Filter) ([]Entry, error) {
	if strings.TrimSpace(logPath) == "" {
		return nil, fmt.Errorf("log path required")
	}

	f, err := os.Open(logPath)
	if err != nil {
		return nil, fmt.Errorf("open log file: %w", err)
	}
	defer f.Close()

	normalizedLevel := strings.ToLower(strings.TrimSpace(filter.Level))
	taskID := strings.TrimSpace(filter.TaskID)
	pattern := strings.ToLower(strings.TrimSpace(filter.Pattern))

	reader := bufio.NewReader(f)
	entries := make([]Entry, 0)
	lineNo := 0

	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil && readErr != io.EOF {
			return nil, fmt.Errorf("read log file: %w", readErr)
		}
		if line == "" && readErr == io.EOF {
			break
		}

		lineNo++
		raw := strings.TrimSpace(line)
		if raw == "" {
			if readErr == io.EOF {
				break
			}
			continue
		}

		entry, err := parseEntry(raw)
		if err != nil {
			return nil, fmt.Errorf("parse log line %d: %w", lineNo, err)
		}

		if normalizedLevel != "" && strings.ToLower(entry.Level) != normalizedLevel {
			if readErr == io.EOF {
				break
			}
			continue
		}

		if taskID != "" && attrString(entry.Attrs["task_id"]) != taskID {
			if readErr == io.EOF {
				break
			}
			continue
		}

		if !filter.Since.IsZero() && entry.Time.Before(filter.Since) {
			if readErr == io.EOF {
				break
			}
			continue
		}

		if pattern != "" && !matchesPattern(entry, raw, pattern) {
			if readErr == io.EOF {
				break
			}
			continue
		}

		entries = append(entries, entry)
		if filter.Limit > 0 && len(entries) >= filter.Limit {
			break
		}

		if readErr == io.EOF {
			break
		}
	}

	return entries, nil
}

func parseEntry(raw string) (Entry, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return Entry{}, err
	}

	var entry Entry
	if timeRaw, ok := payload["time"].(string); ok && strings.TrimSpace(timeRaw) != "" {
		t, err := time.Parse(time.RFC3339Nano, timeRaw)
		if err != nil {
			return Entry{}, fmt.Errorf("invalid time %q: %w", timeRaw, err)
		}
		entry.Time = t
	}
	if levelRaw, ok := payload["level"].(string); ok {
		entry.Level = levelRaw
	}
	if msgRaw, ok := payload["msg"].(string); ok {
		entry.Msg = msgRaw
	}

	entry.Attrs = make(map[string]any, len(payload))
	for k, v := range payload {
		switch k {
		case "time", "level", "msg":
			continue
		default:
			entry.Attrs[k] = v
		}
	}
	if len(entry.Attrs) == 0 {
		entry.Attrs = nil
	}

	return entry, nil
}

func matchesPattern(entry Entry, raw, pattern string) bool {
	if strings.Contains(strings.ToLower(entry.Msg), pattern) {
		return true
	}
	if strings.Contains(strings.ToLower(raw), pattern) {
		return true
	}
	return false
}

func attrString(v any) string {
	s, _ := v.(string)
	return s
}
