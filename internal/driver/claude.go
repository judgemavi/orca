package driver

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Claude implements the Driver interface for Claude Code CLI.
type Claude struct{}

func (c *Claude) Name() string   { return "claude" }
func (c *Claude) Binary() string { return "claude" }

func (c *Claude) Models() []string {
	return []string{
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"claude-haiku-4-5-20251001",
		"claude-opus-4-5-20251101",
		"claude-sonnet-4-5-20250929",
	}
}

func (c *Claude) HeadlessArgs(prompt, model string) []string {
	args := []string{
		"-p", prompt,
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode", "bypassPermissions",
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

func (c *Claude) InteractiveArgs(mcpConfig, allowedTools, context, model string) []string {
	args := []string{
		"--mcp-config", mcpConfig,
		"--allowedTools", allowedTools,
		"--append-system-prompt", context,
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

func (c *Claude) ResumeArgs(sessionID, feedback, model string) []string {
	args := []string{
		"--resume", sessionID,
		"-p", feedback,
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode", "bypassPermissions",
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

func (c *Claude) ParseEvent(line []byte) (Event, error) {
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		return Event{Type: EventUnknown, Raw: string(line)}, nil
	}

	typ, _ := raw["type"].(string)

	if typ == "stream_event" {
		if evt, ok := raw["event"].(map[string]any); ok {
			if delta, ok := evt["delta"].(map[string]any); ok {
				if deltaType, _ := delta["type"].(string); deltaType == "text_delta" {
					text, _ := delta["text"].(string)
					return Event{Type: EventText, Text: text, Raw: string(line)}, nil
				}
			}
		}
	}

	if typ == "result" {
		sessionID, _ := raw["session_id"].(string)
		var cost *Cost
		if totalCost, ok := raw["total_cost_usd"].(float64); ok {
			cost = &Cost{TotalCost: totalCost}
			if usage, ok := raw["usage"].(map[string]any); ok {
				if in, ok := usage["input_tokens"].(float64); ok {
					cost.InputTokens = int64(in)
				}
				if out, ok := usage["output_tokens"].(float64); ok {
					cost.OutputTokens = int64(out)
				}
			}
		}
		return Event{Type: EventCost, SessionID: sessionID, Cost: cost, Raw: string(line)}, nil
	}

	return Event{Type: EventStatus, Raw: string(line)}, nil
}

func (c *Claude) ParseSessionID(events []Event) string {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].SessionID != "" {
			return events[i].SessionID
		}
	}
	return ""
}

func (c *Claude) FormatEvent(line []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		return ""
	}

	typ, _ := raw["type"].(string)

	if typ == "stream_event" {
		evt, _ := raw["event"].(map[string]any)
		if evt == nil {
			return ""
		}
		eventType, _ := evt["type"].(string)

		switch eventType {
		case "content_block_start":
			cb, _ := evt["content_block"].(map[string]any)
			if cb == nil {
				return ""
			}
			if cbType, _ := cb["type"].(string); cbType == "tool_use" {
				name, _ := cb["name"].(string)
				if name == "" {
					return ""
				}
				return fmt.Sprintf("[tool: %s]\n", name)
			}
			return ""
		case "content_block_delta":
			delta, _ := evt["delta"].(map[string]any)
			if delta == nil {
				return ""
			}
			deltaType, _ := delta["type"].(string)
			switch deltaType {
			case "text_delta":
				text, _ := delta["text"].(string)
				return text
			case "input_json_delta":
				partial, _ := delta["partial_json"].(string)
				return partial
			}
			return ""
		case "content_block_stop":
			return "\n"
		case "message_start":
			return "[message start]\n"
		case "message_stop":
			return "[message stop]\n"
		case "message_delta":
			// Stop reason / usage update
			if delta, ok := evt["delta"].(map[string]any); ok {
				if reason, _ := delta["stop_reason"].(string); reason != "" {
					return fmt.Sprintf("[stop: %s]\n", reason)
				}
			}
			return ""
		default:
			return fmt.Sprintf("[%s]\n", eventType)
		}
	}

	if typ == "result" {
		parts := make([]string, 0, 3)
		if sid, _ := raw["session_id"].(string); sid != "" {
			parts = append(parts, fmt.Sprintf("session: %s", sid))
		}
		if usage, ok := raw["usage"].(map[string]any); ok {
			var in, out int64
			if v, ok := usage["input_tokens"].(float64); ok {
				in = int64(v)
			}
			if v, ok := usage["output_tokens"].(float64); ok {
				out = int64(v)
			}
			if in > 0 || out > 0 {
				parts = append(parts, fmt.Sprintf("tokens: %s in / %s out", formatTokens(in), formatTokens(out)))
			}
		}
		if cost, ok := raw["total_cost_usd"].(float64); ok && cost > 0 {
			parts = append(parts, fmt.Sprintf("cost: $%.3f", cost))
		}
		if len(parts) == 0 {
			return ""
		}
		return fmt.Sprintf("[%s]\n", strings.Join(parts, " | "))
	}

	// Never silently drop — show event type for anything unrecognized
	return fmt.Sprintf("[%s]\n", typ)
}
