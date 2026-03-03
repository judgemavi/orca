package toolcfg

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Config is the root JSON schema for tool definitions.
type Config struct {
	Tools map[string]Tool `json:"tools"`
}

// Tool describes one tool's executable and argument resolution schema.
type Tool struct {
	Binary    string    `json:"binary"`
	Models    []string  `json:"models"`
	Args      []Arg     `json:"args"`
	SessionID SessionID `json:"session_id"`
	Timeout   string    `json:"timeout"`
}

// Arg is one argument declaration used by one or more modes.
type Arg struct {
	Param    string   `json:"param"`
	Value    string   `json:"value,omitempty"`
	Variable string   `json:"variable,omitempty"`
	UsedIn   []string `json:"used_in"`
}

const (
	ArgsModeHeadless    = "headless"
	ArgsModeInteractive = "interactive"
	ArgsModeResume      = "resume"
)

// SessionID configures how to extract session IDs from tool stdout lines.
type SessionID struct {
	Mode    string `json:"mode"`
	Key     string `json:"key"`
	Pattern string `json:"pattern"`
}

// Validate checks semantic constraints for tool definitions.
func (c *Config) Validate() error {
	names := make([]string, 0, len(c.Tools))
	for name := range c.Tools {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		tool := c.Tools[name]
		if err := validateTool(name, tool); err != nil {
			return err
		}
	}

	return nil
}

func validateTool(name string, tool Tool) error {
	if strings.TrimSpace(tool.Binary) == "" {
		return fmt.Errorf("tools.%s.binary must be non-empty", name)
	}
	if len(tool.Models) == 0 {
		return fmt.Errorf("tools.%s.models must contain at least one model", name)
	}
	if len(tool.Args) == 0 {
		return fmt.Errorf("tools.%s.args must contain at least one arg", name)
	}
	if err := validateArgs(name, tool.Args); err != nil {
		return err
	}
	if !hasPromptVariableForMode(tool.Args, ArgsModeHeadless) {
		return fmt.Errorf("tools.%s.args must include variable=prompt for headless mode", name)
	}
	mode := strings.TrimSpace(strings.ToLower(tool.SessionID.Mode))
	switch mode {
	case "json":
		if strings.TrimSpace(tool.SessionID.Key) == "" {
			return fmt.Errorf("tools.%s.session_id.key is required when mode=json", name)
		}
	case "pattern":
		pattern := strings.TrimSpace(tool.SessionID.Pattern)
		if pattern == "" {
			return fmt.Errorf("tools.%s.session_id.pattern is required when mode=pattern", name)
		}
		if _, err := regexp.Compile(pattern); err != nil {
			return fmt.Errorf("tools.%s.session_id.pattern must be a valid regex: %w", name, err)
		}
	default:
		return fmt.Errorf("tools.%s.session_id.mode must be one of: json, pattern", name)
	}
	if _, err := time.ParseDuration(tool.Timeout); err != nil {
		return fmt.Errorf("tools.%s.timeout must be a valid duration: %w", name, err)
	}
	return nil
}

// ResolveArgs resolves args for one mode into a flat argv slice.
func (t Tool) ResolveArgs(mode string, vars map[string]string) []string {
	mode = strings.TrimSpace(strings.ToLower(mode))
	out := make([]string, 0, len(t.Args)*2)
	for _, a := range t.Args {
		if !argUsedInMode(a, mode) {
			continue
		}
		param := strings.TrimSpace(a.Param)
		if param == "" {
			continue
		}
		out = append(out, param)
		if value := strings.TrimSpace(a.Value); value != "" {
			out = append(out, value)
			continue
		}
		if variable := strings.TrimSpace(a.Variable); variable != "" {
			out = append(out, vars[variable])
			continue
		}
		// flag-only arg
	}
	return out
}

func validateArgs(toolName string, args []Arg) error {
	for i, a := range args {
		prefix := fmt.Sprintf("tools.%s.args[%d]", toolName, i)
		if strings.TrimSpace(a.Param) == "" {
			return fmt.Errorf("%s.param must be non-empty", prefix)
		}
		value := strings.TrimSpace(a.Value)
		variable := strings.TrimSpace(a.Variable)
		if value != "" && variable != "" {
			return fmt.Errorf("%s.value and %s.variable are mutually exclusive", prefix, prefix)
		}
		if variable != "" {
			if _, ok := knownArgVariables[variable]; !ok {
				return fmt.Errorf("%s.variable %q is not supported", prefix, variable)
			}
		}
		if len(a.UsedIn) == 0 {
			return fmt.Errorf("%s.used_in must contain at least one mode", prefix)
		}
		for _, mode := range a.UsedIn {
			mode = strings.TrimSpace(strings.ToLower(mode))
			if _, ok := validArgModes[mode]; !ok {
				return fmt.Errorf("%s.used_in contains invalid mode %q", prefix, mode)
			}
		}
	}
	return nil
}

func argUsedInMode(a Arg, mode string) bool {
	for _, m := range a.UsedIn {
		if strings.TrimSpace(strings.ToLower(m)) == mode {
			return true
		}
	}
	return false
}

func hasPromptVariableForMode(args []Arg, mode string) bool {
	for _, a := range args {
		if strings.TrimSpace(a.Variable) != "prompt" {
			continue
		}
		if argUsedInMode(a, mode) {
			return true
		}
	}
	return false
}

var validArgModes = map[string]struct{}{
	ArgsModeHeadless:    {},
	ArgsModeInteractive: {},
	ArgsModeResume:      {},
}

var knownArgVariables = map[string]struct{}{
	"prompt":        {},
	"model":         {},
	"dir":           {},
	"session_id":    {},
	"feedback":      {},
	"mcp_config":    {},
	"allowed_tools": {},
	"context":       {},
}

// TimeoutDuration parses timeout into a time.Duration.
func (t Tool) TimeoutDuration() (time.Duration, error) {
	return time.ParseDuration(t.Timeout)
}
