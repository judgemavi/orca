package cost

import (
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"

	"github.com/jasjeetmavi/pod/internal/config"
)

// ParseCost extracts cost data from tool output based on the tool's
// configured cost mode. Returns zeros for tools that don't report cost.
func ParseCost(cfg config.ToolCostConfig, stdout string) (inputTokens, outputTokens int64, cost float64, err error) {
	switch strings.ToLower(strings.TrimSpace(cfg.Mode)) {
	case "json_field":
		return parseJSONFieldCost(stdout, cfg.CostField, cfg.UsageInput, cfg.UsageOutput)
	case "regex":
		return parseRegexCost(stdout, cfg.Pattern)
	default: // "none" or empty
		return 0, 0, 0, nil
	}
}

func parseJSONFieldCost(stdout, costField, usageInputField, usageOutputField string) (inputTokens, outputTokens int64, cost float64, err error) {
	var parsed any
	if err := json.Unmarshal([]byte(stdout), &parsed); err != nil {
		return 0, 0, 0, nil
	}

	inputTokens = int64(numberAtPath(parsed, usageInputField))
	// Preserve previous Claude behavior by including cache token fields when available.
	inputTokens += int64(numberAtPath(parsed, "usage.cache_creation_input_tokens"))
	inputTokens += int64(numberAtPath(parsed, "usage.cache_read_input_tokens"))
	outputTokens = int64(numberAtPath(parsed, usageOutputField))
	cost = numberAtPath(parsed, costField)

	if inputTokens < 0 {
		inputTokens = 0
	}
	if outputTokens < 0 {
		outputTokens = 0
	}
	if cost < 0 {
		cost = 0
	}
	return inputTokens, outputTokens, cost, nil
}

func parseRegexCost(stdout, pattern string) (inputTokens, outputTokens int64, cost float64, err error) {
	p := strings.TrimSpace(pattern)
	if p == "" {
		return 0, 0, 0, nil
	}

	re, err := regexp.Compile(p)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("compile regex: %w", err)
	}

	matches := re.FindStringSubmatch(stdout)
	if len(matches) < 2 {
		return 0, 0, 0, nil
	}

	if len(matches) >= 2 {
		n, ok := parseInt64Capture(matches[1])
		if !ok {
			log.Printf("cost: regex input_tokens capture is non-numeric: %q", matches[1])
			return 0, 0, 0, nil
		}
		if n > 0 {
			inputTokens = n
		}
	}
	if len(matches) >= 3 {
		n, ok := parseInt64Capture(matches[2])
		if !ok {
			log.Printf("cost: regex output_tokens capture is non-numeric: %q", matches[2])
			return 0, 0, 0, nil
		}
		if n > 0 {
			outputTokens = n
		}
	}
	if len(matches) >= 4 {
		n, ok := parseFloatCapture(matches[3])
		if !ok {
			log.Printf("cost: regex cost capture is non-numeric: %q", matches[3])
			return 0, 0, 0, nil
		}
		if n > 0 {
			cost = n
		}
	}
	return inputTokens, outputTokens, cost, nil
}

func numberAtPath(parsed any, path string) float64 {
	path = strings.TrimSpace(path)
	if path == "" {
		return 0
	}

	current := parsed
	for _, token := range strings.Split(path, ".") {
		token = strings.TrimSpace(token)
		if token == "" {
			return 0
		}
		obj, ok := current.(map[string]any)
		if !ok {
			return 0
		}
		next, ok := obj[token]
		if !ok {
			return 0
		}
		current = next
	}

	switch v := current.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		n, err := v.Float64()
		if err != nil {
			return 0
		}
		return n
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0
		}
		return n
	default:
		return 0
	}
}

func parseInt64Capture(s string) (int64, bool) {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func parseFloatCapture(s string) (float64, bool) {
	n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, false
	}
	return n, true
}
