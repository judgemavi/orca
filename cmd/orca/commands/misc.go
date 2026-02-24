package commands

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/cost"
	"github.com/jasjeetmavi/orca/internal/orchestrator"
	"github.com/spf13/cobra"
)

type MiscOptions struct {
	MarkSkipRuntimeInit func(*cobra.Command)
}

func RegisterMisc(root *cobra.Command, r *Registry, opts MiscOptions) {
	root.AddCommand(newInitCmd(r, opts))
	root.AddCommand(newModelsCmd(r, opts))
	root.AddCommand(newCleanupCmd(r))

	logsCmd := &cobra.Command{Use: "logs", Short: "Show application logs", RunE: r.runLogs}
	logsCmd.Flags().String("level", "", "Filter by level: debug|info|warn|error")
	logsCmd.Flags().String("task", "", "Filter by task ID")
	logsCmd.Flags().String("since", "", "Show logs since duration ago (e.g. 30m, 2h)")
	logsCmd.Flags().Int("tail", 50, "Show last N matching lines")
	logsCmd.Flags().BoolP("follow", "f", false, "Stream new matching lines")
	logsCmd.Flags().Bool("json", false, "Output as JSON lines")
	if opts.MarkSkipRuntimeInit != nil {
		opts.MarkSkipRuntimeInit(logsCmd)
	}
	root.AddCommand(logsCmd)

	root.AddCommand(newStatusCmd(r))

	costsCmd := &cobra.Command{Use: "costs", Short: "Show cost tracking summary", RunE: r.runCosts}
	costsCmd.Flags().String("run", "", "Show costs for specific run (prefix ID)")
	root.AddCommand(costsCmd)

	opsCmd := &cobra.Command{Use: "ops", Short: "List tracked operations", RunE: r.runOps}
	opsCmd.Flags().Bool("all", false, "Include historical completed/failed operations")
	root.AddCommand(opsCmd)

	root.AddCommand(newConfigCmd(r, opts))
	root.AddCommand(&cobra.Command{Use: "orc", Short: "Launch orchestrator in current terminal", RunE: r.runOrc})
}

func (r *Registry) runOps(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	includeAll, _ := cmd.Flags().GetBool("all")
	ops, err := listOperations(db, includeAll)
	if err != nil {
		return fmt.Errorf("list operations: %w", err)
	}
	if len(ops) == 0 {
		if includeAll {
			fmt.Println("No operations recorded.")
		} else {
			fmt.Println("No running/recent operations.")
		}
		return nil
	}

	for _, op := range ops {
		var elapsed time.Duration
		if op.Status == "running" {
			elapsed = time.Since(op.CreatedAt)
		} else {
			elapsed = op.UpdatedAt.Sub(op.CreatedAt)
		}
		if elapsed < 0 {
			elapsed = 0
		}

		target := op.TargetID
		if strings.TrimSpace(target) == "" {
			target = "-"
		} else {
			target = short(target)
		}

		fmt.Printf("%-8s %-14s target=%-8s elapsed=%-8s status=%s\n", short(op.ID), op.Type, target, elapsed.Round(time.Second), op.Status)
		if op.Error != "" {
			fmt.Printf("  error: %s\n", op.Error)
		}
	}
	return nil
}

func (r *Registry) runOrc(cmd *cobra.Command, args []string) error {
	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	orcaBinary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve orca binary: %w", err)
	}

	_, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}

	mcpConfigPath, err := orchestrator.WriteMCPConfig(repoDir, orcaBinary, cfg.Tools)
	if err != nil {
		return fmt.Errorf("write mcp config: %w", err)
	}

	_, toolCfg, err := orchestrator.ResolveSupervisorTool(cfg)
	if err != nil {
		return fmt.Errorf("resolve supervisor tool: %w", err)
	}

	launchArgs := orchestrator.BuildLaunchArgs(toolCfg, mcpConfigPath)
	c := exec.Command(toolCfg.Binary, launchArgs...)
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	c.Env = append(os.Environ(), "ORCA_MCP_CONFIG="+mcpConfigPath)
	return c.Run()
}

func (r *Registry) runCosts(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	ct := cost.NewTracker(db)
	runFlag, _ := cmd.Flags().GetString("run")

	if runFlag != "" {
		var runID string
		err := db.QueryRow(`SELECT DISTINCT run_id FROM costs WHERE run_id LIKE ? ORDER BY created_at DESC LIMIT 1`, runFlag+"%").Scan(&runID)
		if err != nil {
			return fmt.Errorf("no run matching %q", runFlag)
		}

		total, _ := ct.RunTotal(runID)
		fmt.Printf("Run %s costs: $%.2f\n\n", short(runID), total)

		summary, err := ct.RunSummary(runID)
		if err != nil {
			return err
		}
		if len(summary) == 0 {
			fmt.Println("No cost data recorded for this run.")
			return nil
		}

		fmt.Println("By tool:")
		for _, s := range summary {
			fmt.Printf("  %-10s $%.2f  (%s in / %s out tokens)\n", s.Tool+":", s.Cost, formatTokens(s.InputTokens), formatTokens(s.OutputTokens))
		}
		return nil
	}

	projectTotal, _ := ct.ProjectTotal()
	if projectTotal == 0 {
		var count int
		db.QueryRow(`SELECT COUNT(*) FROM costs`).Scan(&count)
		if count == 0 {
			fmt.Println("No cost data recorded yet.")
			return nil
		}
	}

	fmt.Printf("Project costs: $%.2f\n\n", projectTotal)

	summary, _ := ct.ProjectSummary()
	if len(summary) > 0 {
		fmt.Println("By tool:")
		for _, s := range summary {
			fmt.Printf("  %-10s $%.2f  (%s in / %s out tokens)\n", s.Tool+":", s.Cost, formatTokens(s.InputTokens), formatTokens(s.OutputTokens))
		}
	}

	rows, err := db.Query(`SELECT run_id, COALESCE(SUM(estimated_cost), 0), COUNT(DISTINCT task_id)
		 FROM costs
		 WHERE run_id IS NOT NULL
		 GROUP BY run_id
		 ORDER BY MIN(created_at) DESC
		 LIMIT 10`)
	if err == nil {
		defer rows.Close()
		fmt.Println("\nRecent runs:")
		for rows.Next() {
			var id string
			var runCost float64
			var taskCount int
			if err := rows.Scan(&id, &runCost, &taskCount); err != nil {
				continue
			}
			if runCost > 0 {
				fmt.Printf("  Run %s  $%.2f  (%d tasks)\n", short(id), runCost, taskCount)
			}
		}
	}

	budget := cfg.Orchestrator.CostBudget
	if budget > 0 {
		remaining, _ := ct.BudgetRemaining(budget)
		fmt.Printf("\nBudget: $%.2f  remaining: $%.2f\n", budget, remaining)
	} else {
		fmt.Println("\nBudget: unlimited")
	}

	return nil
}
