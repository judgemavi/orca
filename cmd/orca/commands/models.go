package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/model"
	"github.com/spf13/cobra"
)

func newModelsCmd(r *Registry, opts MiscOptions) *cobra.Command {
	modelsCmd := &cobra.Command{Use: "models [tool]", Short: "List available models for configured tools", Args: cobra.MaximumNArgs(1), RunE: r.runModels}
	if opts.MarkSkipRuntimeInit != nil {
		opts.MarkSkipRuntimeInit(modelsCmd)
	}
	return modelsCmd
}

func (r *Registry) runModels(cmd *cobra.Command, args []string) error {
	cfgPath := filepath.Join(".orca", "orca.yaml")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("orca not initialized — run 'orca init' first")
		}
		return fmt.Errorf("load config: %w", err)
	}

	var toolNames []string
	if len(args) == 1 {
		toolName := args[0]
		if _, ok := cfg.Tools[toolName]; !ok {
			return fmt.Errorf("tool %q not found in config", toolName)
		}
		toolNames = []string{toolName}
	} else {
		toolNames = make([]string, 0, len(cfg.Tools))
		for name := range cfg.Tools {
			toolNames = append(toolNames, name)
		}
		sort.Strings(toolNames)
	}

	multi := len(toolNames) > 1
	for i, toolName := range toolNames {
		tc := cfg.Tools[toolName]
		models := model.FromConfig(toolName, tc)

		if multi {
			if i > 0 {
				fmt.Println()
			}
			fmt.Printf("%s\n", toolName)
		}
		fmt.Printf("%-40s %s\n", "MODEL ID", "PROVIDER")
		for _, m := range models {
			fmt.Printf("%-40s %s\n", m.ID, m.Provider)
		}
		if len(models) == 0 {
			fmt.Println("(no models configured)")
		}
	}
	return nil
}
