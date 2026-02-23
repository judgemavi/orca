package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/jasjeetmavi/orca/internal/logging"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

func (r *Registry) runLogs(cmd *cobra.Command, args []string) error {
	level, _ := cmd.Flags().GetString("level")
	taskID, _ := cmd.Flags().GetString("task")
	sprintID, _ := cmd.Flags().GetString("sprint")
	sinceRaw, _ := cmd.Flags().GetString("since")
	tail, _ := cmd.Flags().GetInt("tail")
	follow, _ := cmd.Flags().GetBool("follow")
	jsonOut, _ := cmd.Flags().GetBool("json")

	if tail < 0 {
		return fmt.Errorf("--tail must be >= 0")
	}

	normalizedLevel := strings.ToLower(strings.TrimSpace(level))
	switch normalizedLevel {
	case "", "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("invalid --level %q (must be one of: debug|info|warn|error)", level)
	}

	var since time.Time
	if strings.TrimSpace(sinceRaw) != "" {
		d, err := time.ParseDuration(strings.TrimSpace(sinceRaw))
		if err != nil {
			return fmt.Errorf("parse --since: %w", err)
		}
		if d < 0 {
			return fmt.Errorf("--since must be >= 0")
		}
		since = time.Now().Add(-d)
	}

	logPath, err := resolveLogPath()
	if err != nil {
		return err
	}

	filter := logging.Filter{
		Level:    normalizedLevel,
		TaskID:   strings.TrimSpace(taskID),
		SprintID: strings.TrimSpace(sprintID),
		Since:    since,
	}

	entries, err := logging.Query(logPath, filter)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if follow {
				return followLogs(cmd, logPath, filter, 0, jsonOut)
			}
			fmt.Println("No logs yet.")
			return nil
		}
		return fmt.Errorf("query logs: %w", err)
	}

	start := 0
	if tail > 0 && len(entries) > tail {
		start = len(entries) - tail
	}
	if tail == 0 {
		start = len(entries)
	}
	for _, entry := range entries[start:] {
		if err := printLogEntry(entry, jsonOut); err != nil {
			return err
		}
	}

	if !follow {
		return nil
	}

	return followLogs(cmd, logPath, filter, len(entries), jsonOut)
}

func followLogs(cmd *cobra.Command, logPath string, filter logging.Filter, seen int, jsonOut bool) error {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	for {
		select {
		case <-cmd.Context().Done():
			return nil
		case <-sigCh:
			return nil
		case <-ticker.C:
			entries, err := logging.Query(logPath, filter)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				return fmt.Errorf("query logs: %w", err)
			}

			if len(entries) < seen {
				seen = 0
			}
			for _, entry := range entries[seen:] {
				if err := printLogEntry(entry, jsonOut); err != nil {
					return err
				}
			}
			seen = len(entries)
		}
	}
}

func printLogEntry(entry logging.Entry, jsonOut bool) error {
	if jsonOut {
		line, err := marshalEntry(entry)
		if err != nil {
			return fmt.Errorf("marshal log entry: %w", err)
		}
		fmt.Println(line)
		return nil
	}
	fmt.Println(formatHumanEntry(entry))
	return nil
}

func marshalEntry(entry logging.Entry) (string, error) {
	payload := make(map[string]any, 3+len(entry.Attrs))
	if !entry.Time.IsZero() {
		payload["time"] = entry.Time.UTC().Format(time.RFC3339Nano)
	}
	payload["level"] = entry.Level
	payload["msg"] = entry.Msg
	for k, v := range entry.Attrs {
		payload[k] = v
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func formatHumanEntry(entry logging.Entry) string {
	timestamp := "-"
	if !entry.Time.IsZero() {
		timestamp = entry.Time.Local().Format("2006-01-02 15:04:05")
	}

	level := strings.ToUpper(strings.TrimSpace(entry.Level))
	if level == "" {
		level = "INFO"
	}
	msg := strings.TrimSpace(entry.Msg)

	parts := []string{timestamp, level, msg}
	attrKeys := make([]string, 0, len(entry.Attrs))
	for k := range entry.Attrs {
		attrKeys = append(attrKeys, k)
	}
	sort.Strings(attrKeys)
	for _, key := range attrKeys {
		parts = append(parts, fmt.Sprintf("%s=%v", key, entry.Attrs[key]))
	}

	return strings.TrimSpace(strings.Join(parts, " "))
}

func resolveLogPath() (string, error) {
	cfgPath := filepath.Join(".orca", "orca.yaml")
	defaultPath := filepath.Join(".orca", "orca.log")

	data, err := os.ReadFile(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return defaultPath, nil
		}
		return "", fmt.Errorf("read config: %w", err)
	}

	var cfg struct {
		Logging struct {
			File string `yaml:"file"`
		} `yaml:"logging"`
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return "", fmt.Errorf("parse config: %w", err)
	}

	logPath := strings.TrimSpace(cfg.Logging.File)
	if logPath == "" {
		return defaultPath, nil
	}
	return logPath, nil
}
