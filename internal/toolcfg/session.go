package toolcfg

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// ExtractSessionID extracts a session ID from one stdout line using configured mode.
func ExtractSessionID(cfg SessionID, line string) string {
	mode := strings.TrimSpace(strings.ToLower(cfg.Mode))
	switch mode {
	case "json":
		return extractSessionIDJSON(cfg.Key, line)
	case "pattern":
		return extractSessionIDPattern(cfg.Pattern, line)
	default:
		return ""
	}
}

func extractSessionIDPattern(pattern, line string) string {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return ""
	}
	matches := re.FindStringSubmatch(line)
	if len(matches) > 1 {
		return matches[1]
	}
	if len(matches) == 1 {
		return matches[0]
	}

	return ""
}

func extractSessionIDJSON(keyPath, line string) string {
	keyPath = strings.TrimSpace(keyPath)
	if keyPath == "" {
		return ""
	}
	var raw any
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return ""
	}
	current := raw
	for _, key := range strings.Split(keyPath, ".") {
		key = strings.TrimSpace(key)
		if key == "" {
			return ""
		}
		obj, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		next, ok := obj[key]
		if !ok {
			return ""
		}
		current = next
	}

	switch v := current.(type) {
	case string:
		return strings.TrimSpace(v)
	case json.Number:
		return v.String()
	case float64, bool, int, int64, uint64:
		return fmt.Sprint(v)
	default:
		return ""
	}
}
