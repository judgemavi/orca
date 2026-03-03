package toolcfg

import (
	"encoding/json"
	"fmt"
	"strings"
)

// FormatLog converts raw NDJSON log content into readable text for a known tool.
// Unknown tools return raw content unchanged.
func FormatLog(toolName string, raw string) string {
	var out strings.Builder
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		formatted := FormatLine(toolName, []byte(line))
		if formatted == "" {
			continue
		}
		out.WriteString(formatted)
	}
	if out.Len() == 0 {
		return raw
	}
	return out.String()
}

// FormatLine converts one raw NDJSON line into readable text for a known tool.
// Unknown tools return the line unchanged.
func FormatLine(toolName string, line []byte) string {
	switch strings.ToLower(strings.TrimSpace(toolName)) {
	case "claude":
		return formatClaudeEvent(line)
	case "codex":
		return formatCodexEvent(line)
	default:
		return string(line)
	}
}

func formatClaudeEvent(line []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		return ""
	}

	typ, _ := raw["type"].(string)

	switch typ {
	case "system":
		return formatClaudeSystemEvent(raw)
	case "stream_event":
		return formatClaudeStreamEvent(raw)
	case "assistant":
		// Accumulated snapshot — content already rendered from stream deltas.
		return ""
	case "user":
		return formatClaudeUserEvent(raw)
	case "result":
		return formatClaudeResultEvent(raw)
	case "rate_limit_event":
		return formatClaudeRateLimitEvent(raw)
	default:
		return fmt.Sprintf("[%s]\n", typ)
	}
}

func formatClaudeSystemEvent(raw map[string]any) string {
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

func formatClaudeStreamEvent(raw map[string]any) string {
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
			return fmt.Sprintf("[tool: %s]\n", name)
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
		return "[message start]\n"

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

func formatClaudeUserEvent(raw map[string]any) string {
	msg, _ := raw["message"].(map[string]any)
	if msg == nil {
		return "[user]\n"
	}

	// Content can be a plain string.
	if content, ok := msg["content"].(string); ok && content != "" {
		return fmt.Sprintf("[user] %s\n", content)
	}

	// Or an array of content blocks (tool_result, text, etc.).
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

func formatClaudeRateLimitEvent(raw map[string]any) string {
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

func formatClaudeResultEvent(raw map[string]any) string {
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
			parts = append(parts, fmt.Sprintf("tokens: %s in / %s out", formatToolTokens(in), formatToolTokens(out)))
		}
	}
	if cost, ok := raw["total_cost_usd"].(float64); ok && cost > 0 {
		parts = append(parts, fmt.Sprintf("cost: $%.4f", cost))
	}

	if len(parts) == 0 {
		return "[result]\n"
	}
	return fmt.Sprintf("[result | %s]\n", strings.Join(parts, " | "))
}

func formatCodexEvent(line []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		return ""
	}

	typ, _ := raw["type"].(string)
	item, _ := raw["item"].(map[string]any)

	switch typ {
	case "item.started":
		if item == nil {
			return ""
		}
		itemType, _ := item["type"].(string)
		switch itemType {
		case "command_execution":
			cmd, _ := item["command"].(string)
			if cmd == "" {
				return ""
			}
			return fmt.Sprintf("[command: %s]\n", cmd)
		case "file_change":
			file, _ := item["file"].(string)
			if file == "" {
				return "[file]\n"
			}
			return fmt.Sprintf("[file: %s]\n", file)
		case "mcp_tool_call":
			name, _ := item["name"].(string)
			if name == "" {
				return "[mcp]\n"
			}
			return fmt.Sprintf("[mcp: %s]\n", name)
		case "reasoning":
			return "[thinking...]\n"
		}
		return ""
	case "item.completed":
		if item == nil {
			return ""
		}
		itemType, _ := item["type"].(string)
		switch itemType {
		case "agent_message":
			text, _ := item["text"].(string)
			if text == "" {
				return ""
			}
			if strings.HasSuffix(text, "\n") {
				return text
			}
			return text + "\n"
		case "reasoning":
			text, _ := item["text"].(string)
			if text == "" {
				return ""
			}
			return fmt.Sprintf("[thinking] %s\n", text)
		case "command_execution":
			if code, ok := item["exit_code"].(float64); ok && code != 0 {
				return fmt.Sprintf("[exit: %d]\n", int(code))
			}
		case "file_change":
			file, _ := item["file"].(string)
			if file != "" {
				return fmt.Sprintf("[file: %s]\n", file)
			}
		}
		return ""
	case "turn.completed":
		if usage, ok := raw["usage"].(map[string]any); ok {
			var in, out int64
			if v, ok := usage["input_tokens"].(float64); ok {
				in = int64(v)
			}
			if v, ok := usage["output_tokens"].(float64); ok {
				out = int64(v)
			}
			if in > 0 || out > 0 {
				return fmt.Sprintf("[tokens: %s in / %s out]\n", formatToolTokens(in), formatToolTokens(out))
			}
		}
		return ""
	case "turn.started":
		return "[turn started]\n"
	case "turn.failed":
		if errMsg, ok := raw["error"].(string); ok && strings.TrimSpace(errMsg) != "" {
			return fmt.Sprintf("[error: %s]\n", errMsg)
		}
		if errObj, ok := raw["error"].(map[string]any); ok {
			if msg, _ := errObj["message"].(string); strings.TrimSpace(msg) != "" {
				return fmt.Sprintf("[error: %s]\n", msg)
			}
		}
		return "[error]\n"
	case "thread.started":
		if tid, ok := raw["thread_id"].(string); ok && tid != "" {
			return fmt.Sprintf("[session: %s]\n", tid)
		}
		return ""
	case "item.updated":
		if item == nil {
			return ""
		}
		itemType, _ := item["type"].(string)
		status, _ := item["status"].(string)
		if status != "" {
			return fmt.Sprintf("[%s: %s]\n", itemType, status)
		}
		return ""
	default:
		// Never silently drop — show event type for unrecognized lines.
		return fmt.Sprintf("[%s]\n", typ)
	}
}

func formatToolTokens(n int64) string {
	if n >= 1000 {
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	}
	return fmt.Sprintf("%d", n)
}
