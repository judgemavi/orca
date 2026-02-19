package worker

import "encoding/json"

// ClaudeEnvelope represents the JSON wrapper from `claude --output-format json`.
type ClaudeEnvelope struct {
	Type    string  `json:"type"`
	Result  string  `json:"result"`
	CostUSD float64 `json:"total_cost_usd"`
	Usage   struct {
		InputTokens              int64 `json:"input_tokens"`
		CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
		CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		OutputTokens             int64 `json:"output_tokens"`
	} `json:"usage"`
}

// ExtractClaudeResult attempts to unwrap a Claude JSON envelope.
// If stdout is a valid Claude envelope, returns the inner result text.
// Otherwise returns stdout unchanged (safe to call on any tool's output).
func ExtractClaudeResult(stdout string) string {
	var env ClaudeEnvelope
	if err := json.Unmarshal([]byte(stdout), &env); err != nil {
		return stdout
	}
	if env.Type == "result" && env.Result != "" {
		return env.Result
	}
	return stdout
}
