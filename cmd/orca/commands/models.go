package commands

import (
	"fmt"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/model"
	"github.com/spf13/cobra"
)

func newModelsCmd(r *Registry, opts MiscOptions) *cobra.Command {
	modelsCmd := &cobra.Command{Use: "models [tool]", Short: "List available models for configured tools", Args: cobra.MaximumNArgs(1), RunE: r.runModels}
	return modelsCmd
}

func (r *Registry) runModels(cmd *cobra.Command, args []string) error {
	_, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}

	var toolNames []string
	if len(args) == 1 {
		toolName := args[0]
		if _, ok := driver.Get(toolName); !ok {
			return fmt.Errorf("tool %q not found in config", toolName)
		}
		toolNames = []string{toolName}
	} else {
		toolNames = append([]string(nil), cfg.Tools...)
	}

	multi := len(toolNames) > 1
	for i, toolName := range toolNames {
		d, _ := driver.Get(toolName)
		models := model.FromDriver(toolName, d)

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
