package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/sprint"
	"github.com/jasjeetmavi/pod/internal/task"
)

// Server is a stdio JSON-RPC endpoint exposing Pod operations as MCP tools.
type Server struct {
	store    *task.Store
	planner  *sprint.Planner
	executor *sprint.Executor
	cfg      *config.Config
	repoDir  string
}

type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Result  interface{} `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func NewServer(store *task.Store, planner *sprint.Planner, executor *sprint.Executor, cfg *config.Config, repoDir string) *Server {
	return &Server{store: store, planner: planner, executor: executor, cfg: cfg, repoDir: repoDir}
}

// Run reads newline-delimited JSON-RPC requests from stdin and writes responses to stdout.
func (s *Server) Run() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 1024*1024), 1024*1024)
	encoder := json.NewEncoder(os.Stdout)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req jsonrpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			_ = encoder.Encode(jsonrpcResponse{
				JSONRPC: "2.0",
				Error:   &rpcError{Code: -32700, Message: "parse error"},
			})
			continue
		}

		resp := s.handleRequest(req)
		if req.ID == nil {
			continue
		}
		if err := encoder.Encode(resp); err != nil {
			return fmt.Errorf("encode response: %w", err)
		}
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}
	return nil
}

func (s *Server) handleRequest(req jsonrpcRequest) jsonrpcResponse {
	if req.JSONRPC != "2.0" {
		return jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32600, Message: "invalid request"}}
	}

	switch req.Method {
	case "initialize":
		return s.handleInitialize(req)
	case "tools/list":
		return s.handleToolsList(req)
	case "tools/call":
		return s.handleToolsCall(req)
	default:
		return jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32601, Message: "method not found"}}
	}
}
