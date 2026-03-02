package commands

import (
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/interaction"
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

	includeAll, _ := cmd.Flags().GetBool("all")
	query := `SELECT id, phase, task_id, status, started_at, finished_at, error FROM task_interactions`
	if !includeAll {
		query += ` WHERE status = 'running' OR COALESCE(finished_at, started_at) >= datetime('now', '-5 minutes')`
	}
	query += ` ORDER BY started_at DESC`

	rows, err := db.Query(query)
	if err != nil {
		return fmt.Errorf("list operations: %w", err)
	}
	defer rows.Close()

	type opRow struct {
		id         string
		phase      string
		taskID     sql.NullString
		status     string
		startedAt  time.Time
		finishedAt sql.NullTime
		errText    sql.NullString
	}

	ops := make([]opRow, 0)
	for rows.Next() {
		var op opRow
		if err := rows.Scan(&op.id, &op.phase, &op.taskID, &op.status, &op.startedAt, &op.finishedAt, &op.errText); err != nil {
			return fmt.Errorf("scan operation: %w", err)
		}
		ops = append(ops, op)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read operations: %w", err)
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
		elapsed := time.Since(op.startedAt)
		if op.status != "running" && op.finishedAt.Valid {
			elapsed = op.finishedAt.Time.Sub(op.startedAt)
		}
		if elapsed < 0 {
			elapsed = 0
		} else {
			elapsed = elapsed.Round(time.Second)
		}

		target := ""
		if op.taskID.Valid {
			target = op.taskID.String
		}
		if strings.TrimSpace(target) == "" {
			target = "-"
		} else {
			target = short(target)
		}

		fmt.Printf("%-8s %-14s target=%-8s elapsed=%-8s status=%s\n", short(op.id), op.phase, target, elapsed, op.status)
		if op.errText.Valid && strings.TrimSpace(op.errText.String) != "" {
			fmt.Printf("  error: %s\n", op.errText.String)
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

	toolName, d, model, err := orchestrator.ResolveSupervisorTool(cfg)
	if err != nil {
		return fmt.Errorf("resolve supervisor tool: %w", err)
	}
	if d == nil {
		return fmt.Errorf("resolve supervisor tool %q: nil driver", toolName)
	}

	launchArgs := orchestrator.BuildLaunchArgs(d, model, mcpConfigPath)
	c := exec.Command(d.Binary(), launchArgs...)
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	c.Env = append(os.Environ(), "ORCA_MCP_CONFIG="+mcpConfigPath)
	return c.Run()
}

func (r *Registry) runCosts(cmd *cobra.Command, args []string) error {
	db, _, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	ct := interaction.NewStore(db, ".orca/interactions")
	runFlag, _ := cmd.Flags().GetString("run")

	if runFlag != "" {
		var runID string
		err := db.QueryRow(`SELECT DISTINCT run_id FROM task_interactions WHERE run_id LIKE ? ORDER BY started_at DESC LIMIT 1`, runFlag+"%").Scan(&runID)
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
		db.QueryRow(`SELECT COUNT(*) FROM task_interactions`).Scan(&count)
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
		 FROM task_interactions
		 WHERE run_id IS NOT NULL
		 GROUP BY run_id
		 ORDER BY MIN(started_at) DESC
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

	return nil
}
