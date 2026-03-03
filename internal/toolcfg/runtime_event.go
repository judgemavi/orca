package toolcfg

import (
	"encoding/json"
	"strings"
)

// EventType categorizes one streamed tool event.
type EventType int

const (
	EventUnknown EventType = iota
	EventText
	EventCost
	EventSession
	EventStatus
	EventError
)

// Cost describes token and cost metadata emitted by tools.
type Cost struct {
	InputTokens  int64
	OutputTokens int64
	TotalCost    float64
}

// Event is a normalized parsed stream event.
type Event struct {
	Type      EventType
	Text      string
	Cost      *Cost
	SessionID string
	Raw       string
}

// ParseEvent parses one NDJSON event line for a known tool.
func ParseEvent(toolName string, line []byte) (Event, error) {
	switch strings.ToLower(strings.TrimSpace(toolName)) {
	case "claude":
		return parseClaudeEvent(line), nil
	case "codex":
		return parseCodexEvent(line), nil
	default:
		return Event{Type: EventUnknown, Raw: string(line)}, nil
	}
}

func parseClaudeEvent(line []byte) Event {
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		return Event{Type: EventUnknown, Raw: string(line)}
	}

	typ, _ := raw["type"].(string)

	if typ == "stream_event" {
		if evt, ok := raw["event"].(map[string]any); ok {
			if delta, ok := evt["delta"].(map[string]any); ok {
				if deltaType, _ := delta["type"].(string); deltaType == "text_delta" {
					text, _ := delta["text"].(string)
					return Event{Type: EventText, Text: text, Raw: string(line)}
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
		return Event{Type: EventCost, SessionID: sessionID, Cost: cost, Raw: string(line)}
	}

	return Event{Type: EventStatus, Raw: string(line)}
}

func parseCodexEvent(line []byte) Event {
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		return Event{Type: EventUnknown, Raw: string(line)}
	}

	typ, _ := raw["type"].(string)

	if typ == "item.completed" {
		if item, ok := raw["item"].(map[string]any); ok {
			if itemType, _ := item["type"].(string); itemType == "agent_message" {
				text, _ := item["text"].(string)
				return Event{Type: EventText, Text: text, Raw: string(line)}
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
			return Event{Type: EventCost, Cost: cost, Raw: string(line)}
		}
	}

	if typ == "thread.started" {
		if threadID, ok := raw["thread_id"].(string); ok {
			return Event{Type: EventSession, SessionID: threadID, Raw: string(line)}
		}
	}

	return Event{Type: EventStatus, Raw: string(line)}
}
