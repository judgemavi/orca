package mcp

import (
	"encoding/json"
	"fmt"
)

func parseArgs[T any](argsRaw json.RawMessage) (T, error) {
	var args T
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return args, fmt.Errorf("parse args: %w", err)
	}
	return args, nil
}
