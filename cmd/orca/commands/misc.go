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

	logCmd := &cobra.Command{Use: "log", Short: "Show sprint history", RunE: r.runLog}
	logCmd.Flags().Bool("all", false, "Show all sprints (default: last 10)")
	root.AddCommand(logCmd)

	logsCmd := &cobra.Command{Use: "logs", Short: "Show application logs", RunE: r.runLogs}
	logsCmd.Flags().String("level", "", "Filter by level: debug|info|warn|error")
	logsCmd.Flags().String("task", "", "Filter by task ID")
	logsCmd.Flags().String("sprint", "", "Filter by sprint ID")
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
	costsCmd.Flags().String("sprint", "", "Show costs for specific sprint (prefix ID)")
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

func (r *Registry) runLog(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	showAll, _ := cmd.Flags().GetBool("all")
	query := `SELECT id, status, created_at, completed_at FROM sprints ORDER BY created_at DESC`
	if !showAll {
		query += ` LIMIT 10`
	}

	rows, err := db.Query(query)
	if err != nil {
		return fmt.Errorf("query sprints: %w", err)
	}
	defer rows.Close()

	type sprintRow struct {
		id          string
		status      string
		createdAt   time.Time
		completedAt *time.Time
	}
	var sprints []sprintRow
	for rows.Next() {
		var sr sprintRow
		if err := rows.Scan(&sr.id, &sr.status, &sr.createdAt, &sr.completedAt); err != nil {
			return fmt.Errorf("scan sprint: %w", err)
		}
		sprints = append(sprints, sr)
	}

	if len(sprints) == 0 {
		fmt.Println("No sprints yet.")
		return nil
	}

	for _, s := range sprints {
		var total, completed, failed int
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE sprint_id = ?`, s.id).Scan(&total)
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE sprint_id = ? AND status = 'approved'`, s.id).Scan(&completed)
		db.QueryRow(`SELECT COUNT(*) FROM tasks WHERE sprint_id = ? AND status = 'failed'`, s.id).Scan(&failed)

		fmt.Printf("Sprint %s  %s  %s\n", short(s.id), s.status, s.createdAt.Format("2006-01-02 15:04"))
		if failed > 0 {
			fmt.Printf("  %d/%d tasks succeeded, %d failed\n", completed, total, failed)
		} else {
			fmt.Printf("  %d/%d tasks succeeded\n", completed, total)
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

	_, cfg, _, _, err := r.loadRuntimeOrErr()
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
	db, cfg, _, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	ct := cost.NewTracker(db)
	sprintFlag, _ := cmd.Flags().GetString("sprint")

	if sprintFlag != "" {
		var sprintID string
		err := db.QueryRow(`SELECT id FROM sprints WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1`, sprintFlag+"%").Scan(&sprintID)
		if err != nil {
			return fmt.Errorf("no sprint matching %q", sprintFlag)
		}

		total, _ := ct.SprintTotal(sprintID)
		fmt.Printf("Sprint %s costs: $%.2f\n\n", short(sprintID), total)

		summary, err := ct.SprintSummary(sprintID)
		if err != nil {
			return err
		}
		if len(summary) == 0 {
			fmt.Println("No cost data recorded for this sprint.")
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

	rows, err := db.Query(`SELECT s.id, COALESCE(SUM(c.estimated_cost), 0), COUNT(DISTINCT c.task_id)
		 FROM sprints s
		 LEFT JOIN costs c ON c.sprint_id = s.id
		 GROUP BY s.id
		 ORDER BY s.created_at DESC
		 LIMIT 10`)
	if err == nil {
		defer rows.Close()
		fmt.Println("\nRecent sprints:")
		for rows.Next() {
			var id string
			var sprintCost float64
			var taskCount int
			if err := rows.Scan(&id, &sprintCost, &taskCount); err != nil {
				continue
			}
			if sprintCost > 0 {
				fmt.Printf("  Sprint %s  $%.2f  (%d tasks)\n", short(id), sprintCost, taskCount)
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
