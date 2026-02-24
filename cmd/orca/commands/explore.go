package commands

import (
	"fmt"
	"io"
	"os"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/spf13/cobra"
)

func RegisterExplore(root *cobra.Command, r *Registry) {
	exploreCmd := &cobra.Command{Use: "explore", Short: "Analyze codebase and generate context for workers", RunE: r.runExplore}
	exploreCmd.Flags().String("tool", "", "Tool to use for exploration")
	exploreCmd.Flags().String("manual", "", "Path to markdown file to use as context")
	exploreCmd.Flags().Bool("stdin", false, "Read context from stdin")
	exploreCmd.Flags().Bool("check", false, "Check exploration context staleness and exit")
	root.AddCommand(exploreCmd)
}

func (r *Registry) runExplore(cmd *cobra.Command, args []string) error {
	repoDir, _ := os.Getwd()
	checkFlag, _ := cmd.Flags().GetBool("check")
	if checkFlag {
		ctx := explore.LoadContext(repoDir)
		if ctx == "" {
			fmt.Println("No exploration context found. Run: orca explore")
			os.Exit(1)
		}
		stale, err := explore.IsStale(repoDir)
		if err != nil {
			errorf("staleness check failed: %v", err)
			os.Exit(1)
		}
		age := explore.ContextAge(repoDir)
		if stale {
			fmt.Printf("Context is STALE (age: %s, codebase changed since exploration)\n", formatDuration(age))
			fmt.Println("Run: orca explore")
			os.Exit(1)
		}
		fmt.Printf("Context is fresh (age: %s)\n", formatDuration(age))
		return nil
	}

	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	manualPath, _ := cmd.Flags().GetString("manual")
	useStdin, _ := cmd.Flags().GetBool("stdin")

	if manualPath != "" {
		outPath, err := explore.WriteManualContextFromFile(repoDir, manualPath)
		if err != nil {
			return fmt.Errorf("manual explore: %w", err)
		}
		fmt.Printf("Context written to %s (from %s)\n", outPath, manualPath)
		return nil
	}
	if useStdin {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("read stdin: %w", err)
		}
		outPath, err := explore.WriteManualContext(repoDir, string(data))
		if err != nil {
			return fmt.Errorf("stdin explore: %w", err)
		}
		fmt.Printf("Context written to %s (from stdin)\n", outPath)
		return nil
	}

	toolName, _ := cmd.Flags().GetString("tool")
	var toolCfg config.ToolConfig
	if toolName != "" {
		tc, ok := cfg.Tools[toolName]
		if !ok {
			return fmt.Errorf("tool %q not found in config", toolName)
		}
		toolCfg = tc
	} else {
		for _, tc := range cfg.Tools {
			toolCfg = tc
			break
		}
	}

	explorer := explore.New(toolCfg, repoDir)
	if explore.LoadContext(repoDir) != "" {
		if stale, err := explore.IsStale(repoDir); err == nil && stale {
			fmt.Println("Note: existing context was stale (codebase changed since last explore). Refreshing...")
		}
	}
	fmt.Println("Exploring codebase...")
	_, err = explorer.Run()
	if err != nil {
		return fmt.Errorf("explore: %w", err)
	}

	fmt.Println("Exploration complete. Context written to .orca/context.md")
	return nil
}

func formatDuration(d time.Duration) string {
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}
