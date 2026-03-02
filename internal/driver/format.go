package driver

import (
	"fmt"
	"strings"
)

// FormatLog converts raw NDJSON log content into readable text for a known tool.
// Unknown tools return raw content unchanged.
func FormatLog(toolName string, raw string) string {
	d, ok := Get(toolName)
	if !ok {
		return raw
	}

	var out strings.Builder
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if line == "" {
			continue
		}
		out.WriteString(d.FormatEvent([]byte(line)))
	}
	return out.String()
}

// FormatLine converts one raw NDJSON line into readable text for a known tool.
// Unknown tools return the line unchanged.
func FormatLine(toolName string, line []byte) string {
	d, ok := Get(toolName)
	if !ok {
		return string(line)
	}
	return d.FormatEvent(line)
}

func formatTokens(n int64) string {
	if n >= 1000 {
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	}
	return fmt.Sprintf("%d", n)
}
