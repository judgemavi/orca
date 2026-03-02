package commands

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/spf13/cobra"
)

func newConfigCmd(r *Registry, opts MiscOptions) *cobra.Command {
	configCmd := &cobra.Command{
		Use:   "config",
		Short: "Manage orca configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	configShowCmd := &cobra.Command{Use: "show", Short: "Print current configuration", RunE: r.runConfigShow}
	configSetCmd := &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Update a configuration value",
		Args:  cobra.ExactArgs(2),
		RunE:  r.runConfigSet,
	}
	configCmd.AddCommand(configShowCmd)
	configCmd.AddCommand(configSetCmd)
	return configCmd
}

func (r *Registry) runConfigShow(cmd *cobra.Command, args []string) error {
	_, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	fmt.Printf("%s\n", string(data))
	return nil
}

func (r *Registry) runConfigSet(cmd *cobra.Command, args []string) error {
	db, _, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	patch, err := buildConfigPatch(args[0], args[1])
	if err != nil {
		return err
	}

	cfg, err := config.UpdateFromDB(db.DB, patch)
	if err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	fmt.Printf("%s\n", string(data))
	return nil
}

func buildConfigPatch(path, rawValue string) (json.RawMessage, error) {
	parts := strings.Split(strings.TrimSpace(path), ".")
	if len(parts) == 0 {
		return nil, fmt.Errorf("key is required")
	}
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			return nil, fmt.Errorf("invalid key path %q", path)
		}
	}

	value := parseConfigValue(rawValue)
	current := map[string]interface{}{parts[len(parts)-1]: value}
	for i := len(parts) - 2; i >= 0; i-- {
		current = map[string]interface{}{parts[i]: current}
	}

	data, err := json.Marshal(current)
	if err != nil {
		return nil, fmt.Errorf("marshal config patch: %w", err)
	}
	return data, nil
}

func parseConfigValue(raw string) interface{} {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}

	if b, err := strconv.ParseBool(trimmed); err == nil {
		return b
	}
	if i, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		return i
	}
	if f, err := strconv.ParseFloat(trimmed, 64); err == nil {
		return f
	}
	if trimmed == "null" {
		return nil
	}

	var parsed interface{}
	if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
		return parsed
	}
	return raw
}
