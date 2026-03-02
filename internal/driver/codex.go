package driver

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Codex implements the Driver interface for codex CLI.
type Codex struct{}

func (c *Codex) Name() string   { return "codex" }
func (c *Codex) Binary() string { return "codex" }

func (c *Codex) Models() []string {
	return []string{
		"gpt-5.3-codex",
		"gpt-5.2-codex",
		"gpt-5.1-codex-max",
		"gpt-5.1-codex",
		"gpt-5-codex",
		"gpt-5-codex-mini",
	}
}

func (c *Codex) HeadlessArgs(prompt, model, dir string) []string {
	var args []string
	if dir != "" {
		args = append(args, "-C", dir)
	}
	args = append(args, "exec", prompt, "--json", "--full-auto")
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

func (c *Codex) InteractiveArgs(_ string, _ string, context, model string) []string {
	args := []string{"-a", "never", context}
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

func (c *Codex) ResumeArgs(sessionID, feedback, model, dir string) []string {
	var args []string
	if dir != "" {
		args = append(args, "-C", dir)
	}
	args = append(args, "exec", "resume", sessionID, feedback, "--json", "--full-auto")
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

func (c *Codex) ParseEvent(line []byte) (Event, error) {
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		return Event{Type: EventUnknown, Raw: string(line)}, nil
	}

	typ, _ := raw["type"].(string)

	if typ == "item.completed" {
		if item, ok := raw["item"].(map[string]any); ok {
			if itemType, _ := item["type"].(string); itemType == "agent_message" {
				text, _ := item["text"].(string)
				return Event{Type: EventText, Text: text, Raw: string(line)}, nil
			}
		}
	}

	if typ == "turn.completed" {
		if usage, ok := raw["usage"].(map[string]any); ok {
			cost := &Cost{}
			if in, ok := usage["input_tokens"].(float64); ok {
				cost.InputTokens = int64(in)
			}
			if out, ok := usage["output_tokens"].(float64); ok {
				cost.OutputTokens = int64(out)
			}
			return Event{Type: EventCost, Cost: cost, Raw: string(line)}, nil
		}
	}

	if typ == "thread.started" {
		if threadID, ok := raw["thread_id"].(string); ok {
			return Event{Type: EventSession, SessionID: threadID, Raw: string(line)}, nil
		}
	}

	return Event{Type: EventStatus, Raw: string(line)}, nil
}

func (c *Codex) ParseSessionID(events []Event) string {
	for _, e := range events {
		if e.SessionID != "" {
			return e.SessionID
		}
	}
	return ""
}

func (c *Codex) FormatEvent(line []byte) string {
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
				return fmt.Sprintf("[tokens: %s in / %s out]\n", formatTokens(in), formatTokens(out))
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
		// Never silently drop — show the event type for anything unrecognized
		return fmt.Sprintf("[%s]\n", typ)
	}
}
