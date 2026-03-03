package toolcfg

import _ "embed"

// DefaultToolsJSON is the embedded default tools configuration.
//
//go:embed defaults/tools.json
var DefaultToolsJSON []byte

// DefaultConfig parses and returns the embedded default tools configuration.
func DefaultConfig() (*Config, error) {
	return Parse(DefaultToolsJSON)
}
