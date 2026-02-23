package commands

import (
	"fmt"
	"path/filepath"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
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
	if opts.MarkSkipRuntimeInit != nil {
		opts.MarkSkipRuntimeInit(configShowCmd)
	}
	configCmd.AddCommand(configShowCmd)
	return configCmd
}

func (r *Registry) runConfigShow(cmd *cobra.Command, args []string) error {
	cfgPath := filepath.Join(".orca", "orca.yaml")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return err
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	fmt.Print(string(data))
	return nil
}
