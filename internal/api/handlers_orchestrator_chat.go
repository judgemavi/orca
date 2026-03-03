package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/orchestrator"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/toolcfg"
)

var orchestratorChatExecCommandContext = exec.CommandContext
var orchestratorChatExecutable = os.Executable

type orchestratorHistoryMessage struct {
	ID        string         `json:"id"`
	SessionID string         `json:"session_id"`
	Role      string         `json:"role"`
	Content   string         `json:"content"`
	Metadata  map[string]any `json:"metadata"`
	CreatedAt time.Time      `json:"created_at"`
}

type orchestratorToolUseEvent struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
	Args string `json:"args"`
}

type orchestratorToolResultEvent struct {
	ToolUseID string `json:"tool_use_id,omitempty"`
	Name      string `json:"name,omitempty"`
	Content   string `json:"content"`
	IsError   bool   `json:"is_error,omitempty"`
}

func (s *Server) handleOrchestratorChat(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if s.db == nil {
		jsonError(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	if s.cfg == nil {
		jsonError(w, "config unavailable", http.StatusInternalServerError)
		return
	}

	type chatReq struct {
		Message string `json:"message"`
	}
	req, ok := decodeJSON[chatReq](w, r, false)
	if !ok {
		return
	}
	req.Message = strings.TrimSpace(req.Message)
	if req.Message == "" {
		jsonError(w, "message required", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	session, err := s.getOrCreateActiveOrchestratorSession()
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	if err := s.db.InsertOrchestratorMessage(
		uuid.NewString(),
		session.ID,
		"user",
		req.Message,
		`{}`,
	); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	historyRows, err := s.db.ListOrchestratorMessages(session.ID)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	prompt := buildOrchestratorChatPrompt(historyRows)

	toolDef, err := orchestrator.ResolveToolDefinition(s.repoDir, session.Tool)
	if err != nil {
		jsonError(w, fmt.Errorf("resolve tool definition: %w", err), http.StatusInternalServerError)
		return
	}
	toolBinary := strings.TrimSpace(toolDef.Binary)
	if toolBinary == "" {
		jsonError(w, fmt.Errorf("tool %q binary is empty", session.Tool), http.StatusInternalServerError)
		return
	}

	orcaBinary, err := orchestratorChatExecutable()
	if err != nil {
		jsonError(w, fmt.Errorf("resolve orca binary: %w", err), http.StatusInternalServerError)
		return
	}
	mcpConfigPath, err := orchestrator.WriteMCPConfig(s.repoDir, orcaBinary, s.cfg.Tools)
	if err != nil {
		jsonError(w, fmt.Errorf("write mcp config: %w", err), http.StatusInternalServerError)
		return
	}

	args := buildOrchestratorChatArgs(toolDef, session, prompt, req.Message, mcpConfigPath, s.repoDir)
	cmd := s.runOrchestratorCommand(r.Context(), toolBinary, args)
	cmd.Dir = s.repoDir
	cmd.Env = append(filteredOrchestratorChatEnv(), "ORCA_MCP_CONFIG="+mcpConfigPath)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		jsonError(w, fmt.Errorf("stdout pipe: %w", err), http.StatusInternalServerError)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		jsonError(w, fmt.Errorf("stderr pipe: %w", err), http.StatusInternalServerError)
		return
	}

	if err := cmd.Start(); err != nil {
		jsonError(w, fmt.Errorf("start %s: %w", toolBinary, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	stderrDone := make(chan string, 1)
	go func() {
		var b strings.Builder
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
		for scanner.Scan() {
			b.WriteString(scanner.Text())
			b.WriteByte('\n')
		}
		stderrDone <- strings.TrimSpace(b.String())
	}()

	var (
		assistantText strings.Builder
		sessionID     string
		inputTokens   int64
		outputTokens  int64
		totalCost     float64
		lastTaskID    string
	)

	// flushAssistantText persists the accumulated assistant text segment
	// before a tool call, so the DB preserves interleaved message order.
	flushAssistantText := func() {
		segment := strings.TrimSpace(assistantText.String())
		if segment == "" {
			return
		}
		meta := map[string]any{}
		if lastTaskID != "" {
			meta["task_id"] = lastTaskID
		}
		metadata := marshalOrDefault(meta, `{}`)
		if err := s.db.InsertOrchestratorMessage(
			uuid.NewString(),
			session.ID,
			"assistant",
			segment,
			metadata,
		); err != nil {
			slog.Warn("persist assistant segment failed", "session_id", session.ID, "err", err)
		}
		assistantText.Reset()
	}

	parser := newToolEventParser()
	stdoutScanner := bufio.NewScanner(stdout)
	stdoutScanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for stdoutScanner.Scan() {
		line := append([]byte(nil), stdoutScanner.Bytes()...)
		if sid := toolcfg.ExtractSessionID(toolDef.SessionID, string(line)); sid != "" {
			sessionID = sid
		}

		if uses, results := parser.parse(line); len(uses) > 0 || len(results) > 0 {
			for _, tu := range uses {
				// Flush any assistant text that came before this tool call.
				flushAssistantText()

				meta := map[string]any{
					"tool_use_id": tu.ID,
					"args":        tu.Args,
				}
				if tid := extractTaskID(tu.Args); tid != "" {
					meta["task_id"] = tid
					lastTaskID = tid
				}
				metadata := marshalOrDefault(meta, `{}`)
				if err := s.db.InsertOrchestratorMessage(
					uuid.NewString(),
					session.ID,
					"tool_use",
					tu.Name,
					metadata,
				); err != nil {
					slog.Warn("persist tool_use failed", "session_id", session.ID, "err", err)
				}
				if err := writeSSEJSON(w, "tool_use", tu); err != nil {
					_ = cmd.Process.Kill()
					return
				}
			}
			for _, tr := range results {
				trMeta := map[string]any{
					"tool_use_id": tr.ToolUseID,
					"name":        tr.Name,
					"is_error":    tr.IsError,
				}
				if tid := extractTaskID(tr.Content); tid != "" {
					trMeta["task_id"] = tid
					lastTaskID = tid
				}
				metadata := marshalOrDefault(trMeta, `{}`)
				if err := s.db.InsertOrchestratorMessage(
					uuid.NewString(),
					session.ID,
					"tool_result",
					tr.Content,
					metadata,
				); err != nil {
					slog.Warn("persist tool_result failed", "session_id", session.ID, "err", err)
				}
				if err := writeSSEJSON(w, "tool_result", tr); err != nil {
					_ = cmd.Process.Kill()
					return
				}
			}
			flusher.Flush()
		}

		event, err := toolcfg.ParseEvent(session.Tool, line)
		if err != nil {
			continue
		}
		switch event.Type {
		case toolcfg.EventText:
			if event.Text == "" {
				continue
			}
			assistantText.WriteString(event.Text)
			if err := writeSSEData(w, "text", event.Text); err != nil {
				_ = cmd.Process.Kill()
				return
			}
			flusher.Flush()
		case toolcfg.EventCost:
			if event.Cost != nil {
				inputTokens += event.Cost.InputTokens
				outputTokens += event.Cost.OutputTokens
				totalCost += event.Cost.TotalCost
			}
			if event.SessionID != "" {
				sessionID = event.SessionID
			}
		case toolcfg.EventSession:
			if event.SessionID != "" {
				sessionID = event.SessionID
			}
		}
	}

	stdoutScanErr := stdoutScanner.Err()
	waitErr := cmd.Wait()
	stderrText := <-stderrDone

	if sessionID != "" {
		if err := s.db.SetOrchestratorSessionResumeID(session.ID, sessionID); err != nil {
			slog.Warn("persist session resume id failed", "session_id", session.ID, "err", err)
		}
	}

	// Flush any remaining assistant text after the last tool call.
	flushAssistantText()

	// Store cost metadata as a final assistant message if there was no trailing text.
	if inputTokens > 0 || outputTokens > 0 || totalCost > 0 {
		costMeta := map[string]any{
			"input_tokens":  inputTokens,
			"output_tokens": outputTokens,
			"total_cost":    totalCost,
		}
		if lastTaskID != "" {
			costMeta["task_id"] = lastTaskID
		}
		// Store as metadata-only assistant message (empty content) for cost tracking.
		// This won't be displayed since content is empty.
		metadata := marshalOrDefault(costMeta, `{}`)
		_ = s.db.InsertOrchestratorMessage(
			uuid.NewString(),
			session.ID,
			"assistant",
			"",
			metadata,
		)
	}

	done := map[string]any{
		"input_tokens":  inputTokens,
		"output_tokens": outputTokens,
		"total_cost":    totalCost,
		"session_id":    sessionID,
	}
	if stdoutScanErr != nil {
		done["error"] = stdoutScanErr.Error()
	}
	if waitErr != nil {
		done["error"] = waitErr.Error()
	}
	if strings.TrimSpace(stderrText) != "" {
		done["stderr"] = stderrText
	}

	_ = writeSSEJSON(w, "done", done)
	flusher.Flush()
}

func (s *Server) handleOrchestratorHistory(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if s.db == nil {
		jsonError(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}

	session, err := s.db.GetActiveOrchestratorSession()
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	if session == nil {
		jsonOK(w, []orchestratorHistoryMessage{})
		return
	}

	rows, err := s.db.ListOrchestratorMessages(session.ID)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	out := make([]orchestratorHistoryMessage, 0, len(rows))
	for _, row := range rows {
		out = append(out, orchestratorHistoryMessage{
			ID:        row.ID,
			SessionID: row.SessionID,
			Role:      row.Role,
			Content:   row.Content,
			Metadata:  decodeMetadata(row.Metadata),
			CreatedAt: row.CreatedAt.UTC(),
		})
	}
	jsonOK(w, out)
}

func (s *Server) handleOrchestratorNewSession(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if s.db == nil {
		jsonError(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	if s.cfg == nil {
		jsonError(w, "config unavailable", http.StatusInternalServerError)
		return
	}

	active, err := s.db.GetActiveOrchestratorSession()
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	if active != nil {
		if err := s.db.CloseOrchestratorSession(active.ID); err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return
		}
	}

	session, err := s.createOrchestratorSession()
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]string{"id": session.ID})
}

func (s *Server) getOrCreateActiveOrchestratorSession() (*state.OrchestratorSessionRow, error) {
	session, err := s.db.GetActiveOrchestratorSession()
	if err != nil {
		return nil, err
	}
	if session != nil {
		return session, nil
	}
	return s.createOrchestratorSession()
}

func (s *Server) createOrchestratorSession() (*state.OrchestratorSessionRow, error) {
	toolName, _, model, err := orchestrator.ResolveSupervisorTool(s.cfg, s.repoDir)
	if err != nil {
		return nil, err
	}
	id := uuid.NewString()
	if err := s.db.CreateOrchestratorSession(id, toolName, model); err != nil {
		return nil, err
	}
	return &state.OrchestratorSessionRow{
		ID:              id,
		Tool:            toolName,
		Model:           model,
		ClaudeSessionID: "",
		Status:          "active",
	}, nil
}

func buildOrchestratorChatPrompt(history []state.OrchestratorMessageRow) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(orchestrator.SystemPrompt))
	b.WriteString("\n\nConversation history:\n")
	for _, msg := range history {
		switch msg.Role {
		case "user":
			b.WriteString("User: ")
			b.WriteString(msg.Content)
			b.WriteByte('\n')
		case "assistant":
			b.WriteString("Assistant: ")
			b.WriteString(msg.Content)
			b.WriteByte('\n')
		case "tool_use":
			meta := decodeMetadata(msg.Metadata)
			args := "{}"
			if raw, ok := meta["args"].(string); ok && strings.TrimSpace(raw) != "" {
				args = raw
			}
			b.WriteString("Assistant used tool ")
			b.WriteString(msg.Content)
			b.WriteString(" with args ")
			b.WriteString(args)
			b.WriteByte('\n')
		case "tool_result":
			b.WriteString("Tool result: ")
			b.WriteString(msg.Content)
			b.WriteByte('\n')
		}
	}
	b.WriteString("Assistant:")
	return b.String()
}

func buildOrchestratorChatArgs(
	tool toolcfg.Tool,
	session *state.OrchestratorSessionRow,
	prompt string,
	userMessage string,
	mcpConfigPath string,
	repoDir string,
) []string {
	model := ""
	if session != nil {
		model = session.Model
	}
	resumeID := ""
	if session != nil {
		resumeID = strings.TrimSpace(session.ClaudeSessionID)
	}

	vars := map[string]string{
		"prompt":        prompt,
		"feedback":      userMessage,
		"model":         model,
		"dir":           repoDir,
		"mcp_config":    mcpConfigPath,
		"allowed_tools": strings.Join(orchestrator.AllowedTools, ","),
		"context":       orchestrator.SystemPrompt,
	}
	var mode string
	if resumeID != "" {
		mode = toolcfg.ArgsModeResume
		vars["session_id"] = resumeID
	} else {
		mode = toolcfg.ArgsModeHeadless
	}
	return compactOrchestratorArgs(tool.ResolveArgs(mode, vars))
}

func compactOrchestratorArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		current := strings.TrimSpace(args[i])
		if current == "" {
			continue
		}
		if takesOrchestratorValueFlag(current) && i+1 < len(args) && strings.TrimSpace(args[i+1]) == "" {
			i++
			continue
		}
		out = append(out, args[i])
	}
	return out
}

func takesOrchestratorValueFlag(arg string) bool {
	switch arg {
	case "--model", "--mcp-config", "--allowedTools", "--append-system-prompt", "--resume", "-C", "--prompt", "-p":
		return true
	default:
		return false
	}
}

func filteredOrchestratorChatEnv() []string {
	env := make([]string, 0, len(os.Environ()))
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "CLAUDECODE=") {
			env = append(env, e)
		}
	}
	return env
}

func writeSSEData(w http.ResponseWriter, event, data string) error {
	if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
		return err
	}
	lines := strings.Split(data, "\n")
	for _, line := range lines {
		if _, err := fmt.Fprintf(w, "data: %s\n", line); err != nil {
			return err
		}
	}
	_, err := fmt.Fprint(w, "\n")
	return err
}

func writeSSEJSON(w http.ResponseWriter, event string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return writeSSEData(w, event, string(data))
}

func decodeMetadata(raw string) map[string]any {
	out := map[string]any{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return map[string]any{"raw": raw}
	}
	return out
}

func marshalOrDefault(v any, fallback string) string {
	data, err := json.Marshal(v)
	if err != nil {
		return fallback
	}
	return string(data)
}

// toolEventParser tracks state across stream-json lines to properly
// accumulate tool_use args from incremental input_json_delta events.
type toolEventParser struct {
	knownToolUses map[string]string

	// Pending tool_use being accumulated (Claude stream_event format).
	pendingID   string
	pendingName string
	pendingArgs strings.Builder
}

func newToolEventParser() *toolEventParser {
	return &toolEventParser{
		knownToolUses: make(map[string]string),
	}
}

// flushPending emits the buffered tool_use event (if any) and resets state.
func (p *toolEventParser) flushPending() *orchestratorToolUseEvent {
	if p.pendingID == "" && p.pendingName == "" {
		return nil
	}
	args := strings.TrimSpace(p.pendingArgs.String())
	if args == "" {
		args = "{}"
	}
	tu := &orchestratorToolUseEvent{ID: p.pendingID, Name: p.pendingName, Args: args}
	p.pendingID = ""
	p.pendingName = ""
	p.pendingArgs.Reset()
	return tu
}

func (p *toolEventParser) parse(line []byte) ([]orchestratorToolUseEvent, []orchestratorToolResultEvent) {
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		return nil, nil
	}

	typ, _ := raw["type"].(string)
	switch typ {
	case "stream_event":
		return p.parseStreamEvent(raw)
	case "user":
		return p.parseUserEvent(raw)
	case "item.started":
		return p.parseItemStarted(raw)
	case "item.completed":
		return p.parseItemCompleted(raw)
	default:
		return nil, nil
	}
}

func (p *toolEventParser) parseStreamEvent(raw map[string]any) ([]orchestratorToolUseEvent, []orchestratorToolResultEvent) {
	evt, _ := raw["event"].(map[string]any)
	if evt == nil {
		return nil, nil
	}
	eventType, _ := evt["type"].(string)

	switch eventType {
	case "content_block_start":
		cb, _ := evt["content_block"].(map[string]any)
		if cb == nil {
			return nil, nil
		}
		if cbType, _ := cb["type"].(string); cbType != "tool_use" {
			return nil, nil
		}
		// Flush any previous pending tool_use before starting a new one.
		var uses []orchestratorToolUseEvent
		if prev := p.flushPending(); prev != nil {
			uses = append(uses, *prev)
		}
		id := firstNonEmptyString(cb["id"], cb["tool_use_id"])
		name := firstNonEmptyString(cb["name"])
		if name == "" {
			name = "tool"
		}
		if id != "" {
			p.knownToolUses[id] = name
		}
		p.pendingID = id
		p.pendingName = name
		p.pendingArgs.Reset()
		return uses, nil

	case "content_block_delta":
		delta, _ := evt["delta"].(map[string]any)
		if delta == nil {
			return nil, nil
		}
		if deltaType, _ := delta["type"].(string); deltaType == "input_json_delta" {
			partial, _ := delta["partial_json"].(string)
			p.pendingArgs.WriteString(partial)
		}
		return nil, nil

	case "content_block_stop":
		if tu := p.flushPending(); tu != nil {
			return []orchestratorToolUseEvent{*tu}, nil
		}
		return nil, nil

	default:
		return nil, nil
	}
}

func (p *toolEventParser) parseUserEvent(raw map[string]any) ([]orchestratorToolUseEvent, []orchestratorToolResultEvent) {
	// Flush any pending tool_use that wasn't closed by content_block_stop.
	var uses []orchestratorToolUseEvent
	if tu := p.flushPending(); tu != nil {
		uses = append(uses, *tu)
	}

	msg, _ := raw["message"].(map[string]any)
	if msg == nil {
		return uses, nil
	}
	contentBlocks, _ := msg["content"].([]any)
	if len(contentBlocks) == 0 {
		return uses, nil
	}
	results := make([]orchestratorToolResultEvent, 0, len(contentBlocks))
	for _, item := range contentBlocks {
		block, _ := item.(map[string]any)
		if block == nil {
			continue
		}
		if blockType, _ := block["type"].(string); blockType != "tool_result" {
			continue
		}
		toolUseID := firstNonEmptyString(block["tool_use_id"], block["id"])
		name := p.knownToolUses[toolUseID]
		content := stringifyToolPayload(block["content"])
		isError, _ := block["is_error"].(bool)
		results = append(results, orchestratorToolResultEvent{
			ToolUseID: toolUseID,
			Name:      name,
			Content:   content,
			IsError:   isError,
		})
	}
	return uses, results
}

func (p *toolEventParser) parseItemStarted(raw map[string]any) ([]orchestratorToolUseEvent, []orchestratorToolResultEvent) {
	item, _ := raw["item"].(map[string]any)
	if item == nil {
		return nil, nil
	}
	if itemType, _ := item["type"].(string); itemType != "mcp_tool_call" {
		return nil, nil
	}
	id := firstNonEmptyString(item["id"], item["tool_call_id"], item["call_id"])
	name := firstNonEmptyString(item["name"], item["tool"])
	args := "{}"
	if v, ok := item["arguments"]; ok {
		args = stringifyToolPayload(v)
	} else if v, ok := item["input"]; ok {
		args = stringifyToolPayload(v)
	} else if v, ok := item["args"]; ok {
		args = stringifyToolPayload(v)
	}
	if name == "" {
		name = "mcp_tool_call"
	}
	if id != "" {
		p.knownToolUses[id] = name
	}
	return []orchestratorToolUseEvent{{ID: id, Name: name, Args: args}}, nil
}

func (p *toolEventParser) parseItemCompleted(raw map[string]any) ([]orchestratorToolUseEvent, []orchestratorToolResultEvent) {
	item, _ := raw["item"].(map[string]any)
	if item == nil {
		return nil, nil
	}
	if itemType, _ := item["type"].(string); itemType != "mcp_tool_call" {
		return nil, nil
	}
	toolUseID := firstNonEmptyString(item["id"], item["tool_call_id"], item["call_id"])
	name := p.knownToolUses[toolUseID]
	content := ""
	if v, ok := item["result"]; ok {
		content = stringifyToolPayload(v)
	} else if v, ok := item["output"]; ok {
		content = stringifyToolPayload(v)
	} else if v, ok := item["text"]; ok {
		content = stringifyToolPayload(v)
	}
	if content == "" {
		content = "{}"
	}
	return nil, []orchestratorToolResultEvent{{
		ToolUseID: toolUseID,
		Name:      name,
		Content:   content,
	}}
}

func firstNonEmptyString(values ...any) string {
	for _, value := range values {
		if s, ok := value.(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

// extractTaskID pulls a task_id field from a JSON string.
func extractTaskID(jsonStr string) string {
	var obj map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &obj); err != nil {
		return ""
	}
	if tid, ok := obj["task_id"].(string); ok && strings.TrimSpace(tid) != "" {
		return strings.TrimSpace(tid)
	}
	// Check nested .task.id or .task.task_id
	if task, ok := obj["task"].(map[string]any); ok {
		if tid, ok := task["id"].(string); ok && strings.TrimSpace(tid) != "" {
			return strings.TrimSpace(tid)
		}
		if tid, ok := task["task_id"].(string); ok && strings.TrimSpace(tid) != "" {
			return strings.TrimSpace(tid)
		}
	}
	return ""
}

func stringifyToolPayload(v any) string {
	switch val := v.(type) {
	case nil:
		return ""
	case string:
		trimmed := strings.TrimSpace(val)
		if trimmed == "" {
			return ""
		}
		return trimmed
	default:
		data, err := json.Marshal(val)
		if err != nil {
			return ""
		}
		return string(data)
	}
}

func (s *Server) runOrchestratorCommand(
	ctx context.Context,
	name string,
	args []string,
) *exec.Cmd {
	return orchestratorChatExecCommandContext(ctx, name, args...)
}
