package worker

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/jasjeetmavi/orca/internal/config"
)

// ExtractOutput extracts the usable result text from a tool's stdout
// based on the tool's configured output mode.
func ExtractOutput(cfg config.ToolOutputConfig, stdout string, worktreePath string) string {
	switch strings.ToLower(strings.TrimSpace(cfg.Mode)) {
	case "json_envelope":
		return extractJSONField(stdout, cfg.ResultField)
	case "file":
		return extractFromFile(cfg.ResultPath, worktreePath, stdout)
	case "regex":
		return extractByRegex(stdout, cfg.Pattern)
	default: // "stdout" or empty
		return stdout
	}
}

func extractJSONField(stdout, resultField string) string {
	field := strings.TrimSpace(resultField)
	if field == "" {
		return stdout
	}

	var parsed any
	if err := json.Unmarshal([]byte(stdout), &parsed); err != nil {
		return stdout
	}

	current := parsed
	for _, token := range strings.Split(field, ".") {
		token = strings.TrimSpace(token)
		if token == "" {
			return stdout
		}

		obj, ok := current.(map[string]any)
		if !ok {
			return stdout
		}
		next, ok := obj[token]
		if !ok {
			return stdout
		}
		current = next
	}

	text, ok := current.(string)
	if !ok || text == "" {
		return stdout
	}
	return text
}

func extractFromFile(resultPath, worktreePath, stdout string) string {
	path := strings.TrimSpace(resultPath)
	if path == "" {
		return stdout
	}

	path = strings.ReplaceAll(path, "{{worktree}}", worktreePath)
	if !filepath.IsAbs(path) {
		path = filepath.Join(worktreePath, path)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		slog.Warn("worker extract output file mode failed", "path", path, "err", err)
		return stdout
	}
	return string(data)
}

func extractByRegex(stdout, pattern string) string {
	p := strings.TrimSpace(pattern)
	if p == "" {
		return stdout
	}

	re, err := regexp.Compile(p)
	if err != nil {
		slog.Warn("worker extract output regex mode failed", "pattern", p, "err", err)
		return stdout
	}
	matches := re.FindStringSubmatch(stdout)
	if len(matches) < 2 {
		return stdout
	}
	return matches[1]
}
