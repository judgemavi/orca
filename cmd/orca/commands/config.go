package commands

import (
	"encoding/json"
	"fmt"

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
	configCmd.AddCommand(configShowCmd)
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
