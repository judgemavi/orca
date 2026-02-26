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

func (c *Claude) HeadlessArgs(prompt, model, _ string) []string {
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

func (c *Claude) ResumeArgs(sessionID, feedback, model, _ string) []string {
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

	switch typ {
	case "system":
		return c.formatSystemEvent(raw)
	case "stream_event":
		return c.formatStreamEvent(raw)
	case "assistant":
		// Accumulated snapshot — content already rendered from stream deltas.
		return ""
	case "user":
		return c.formatUserEvent(raw)
	case "result":
		return c.formatResultEvent(raw)
	case "rate_limit_event":
		return c.formatRateLimitEvent(raw)
	default:
		return fmt.Sprintf("[%s]\n", typ)
	}
}

func (c *Claude) formatSystemEvent(raw map[string]any) string {
	var parts []string
	if model, _ := raw["model"].(string); model != "" {
		parts = append(parts, fmt.Sprintf("model=%s", model))
	}
	if sid, _ := raw["session_id"].(string); sid != "" {
		parts = append(parts, fmt.Sprintf("session=%s", sid))
	}
	if len(parts) == 0 {
		return "[system init]\n"
	}
	return fmt.Sprintf("[system init | %s]\n", strings.Join(parts, " | "))
}

func (c *Claude) formatStreamEvent(raw map[string]any) string {
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
		cbType, _ := cb["type"].(string)
		switch cbType {
		case "tool_use":
			name, _ := cb["name"].(string)
			if name == "" {
				return ""
			}
			return fmt.Sprintf("\n[tool: %s]\n", name)
		case "thinking":
			return "\n[thinking]\n"
		case "text":
			return "\n[assistant]\n"
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
		case "thinking_delta":
			text, _ := delta["thinking"].(string)
			return text
		case "input_json_delta":
			partial, _ := delta["partial_json"].(string)
			return partial
		case "signature_delta":
			return ""
		}
		return ""

	case "content_block_stop":
		return "\n"

	case "message_start":
		return ""

	case "message_delta":
		if delta, ok := evt["delta"].(map[string]any); ok {
			if reason, _ := delta["stop_reason"].(string); reason != "" {
				return fmt.Sprintf("[stop: %s]\n", reason)
			}
		}
		return ""

	case "message_stop":
		return ""

	default:
		return fmt.Sprintf("[%s]\n", eventType)
	}
}

func (c *Claude) formatUserEvent(raw map[string]any) string {
	msg, _ := raw["message"].(map[string]any)
	if msg == nil {
		return "[user]\n"
	}

	// Content can be a plain string
	if content, ok := msg["content"].(string); ok && content != "" {
		return fmt.Sprintf("[user] %s\n", content)
	}

	// Or an array of content blocks (tool_result, text, etc.)
	blocks, _ := msg["content"].([]any)
	if len(blocks) == 0 {
		return "[user]\n"
	}

	var parts []string
	for _, b := range blocks {
		block, _ := b.(map[string]any)
		if block == nil {
			continue
		}
		blockType, _ := block["type"].(string)
		switch blockType {
		case "tool_result":
			toolID, _ := block["tool_use_id"].(string)
			content, _ := block["content"].(string)
			isErr, _ := block["is_error"].(bool)
			label := "tool_result"
			if isErr {
				label = "tool_error"
			}
			if content != "" {
				const maxPreview = 120
				preview := content
				if len(preview) > maxPreview {
					preview = preview[:maxPreview] + "..."
				}
				parts = append(parts, fmt.Sprintf("[%s %s] %s", label, toolID, preview))
			} else {
				parts = append(parts, fmt.Sprintf("[%s %s]", label, toolID))
			}
		case "text":
			text, _ := block["text"].(string)
			if text != "" {
				parts = append(parts, fmt.Sprintf("[user] %s", text))
			}
		}
	}
	if len(parts) == 0 {
		return "[user]\n"
	}
	return strings.Join(parts, "\n") + "\n"
}

func (c *Claude) formatRateLimitEvent(raw map[string]any) string {
	info, _ := raw["rate_limit_info"].(map[string]any)
	if info == nil {
		return "[rate limited]\n"
	}
	status, _ := info["status"].(string)
	limitType, _ := info["rateLimitType"].(string)

	var parts []string
	if status != "" {
		parts = append(parts, status)
	}
	if limitType != "" {
		parts = append(parts, limitType)
	}
	if len(parts) == 0 {
		return "[rate limited]\n"
	}
	return fmt.Sprintf("[rate limit: %s]\n", strings.Join(parts, " | "))
}

func (c *Claude) formatResultEvent(raw map[string]any) string {
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
