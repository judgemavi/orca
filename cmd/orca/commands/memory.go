package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/spf13/cobra"
)

func RegisterMemory(root *cobra.Command, r *Registry) {
	memoryCmd := &cobra.Command{
		Use:   "memory",
		Short: "Manage learned memory entries",
		RunE:  r.runMemoryList,
	}

	listCmd := &cobra.Command{Use: "list", Short: "List memory entries", RunE: r.runMemoryList}
	listCmd.Flags().String("category", "", "Filter by category: pattern|pitfall|preference|convention|architecture|dependency")
	listCmd.Flags().String("tag", "", "Filter by tag")
	listCmd.Flags().String("source-type", "", "Filter by source type: retro|explore")
	listCmd.Flags().String("file", "", "Filter by associated file path")
	listCmd.Flags().Bool("stale", false, "Show stale entries only")
	listCmd.Flags().String("covered-before", "", "Filter entries not covered at this commit SHA")
	listCmd.Flags().Bool("json", false, "Output as JSON")
	memoryCmd.AddCommand(listCmd)

	showCmd := &cobra.Command{Use: "show <id>", Short: "Show a memory entry with lineage", Args: cobra.ExactArgs(1), RunE: r.runMemoryShow}
	memoryCmd.AddCommand(showCmd)

	searchCmd := &cobra.Command{Use: "search <query>", Short: "Search memory entries", Args: cobra.MinimumNArgs(1), RunE: r.runMemorySearch}
	searchCmd.Flags().Int("limit", 10, "Maximum results")
	searchCmd.Flags().String("source-type", "", "Filter by source type: retro|explore")
	searchCmd.Flags().String("file", "", "Filter by associated file path")
	searchCmd.Flags().Bool("json", false, "Output as JSON")
	memoryCmd.AddCommand(searchCmd)

	queryCmd := &cobra.Command{Use: "query <text>", Short: "Natural-language memory query with lineage", Args: cobra.MinimumNArgs(1), RunE: r.runMemoryQuery}
	queryCmd.Flags().Int("limit", 10, "Maximum results")
	queryCmd.Flags().Bool("json", false, "Output as JSON")
	memoryCmd.AddCommand(queryCmd)

	editCmd := &cobra.Command{Use: "edit <id>", Short: "Edit a memory entry", Args: cobra.ExactArgs(1), RunE: r.runMemoryEdit}
	editCmd.Flags().String("content", "", "Updated content")
	editCmd.Flags().Float64("confidence", 0, "Updated confidence (0..1)")
	editCmd.Flags().String("category", "", "Updated category: pattern|pitfall|preference|convention")
	memoryCmd.AddCommand(editCmd)

	deleteCmd := &cobra.Command{Use: "delete <id>", Short: "Delete a memory entry", Args: cobra.ExactArgs(1), RunE: r.runMemoryDelete}
	deleteCmd.Flags().BoolP("yes", "y", false, "Skip confirmation")
	memoryCmd.AddCommand(deleteCmd)

	syncCmd := &cobra.Command{Use: "sync", Short: "Sync memory entries with git changes", RunE: r.runMemorySync}
	memoryCmd.AddCommand(syncCmd)

	refreshCmd := &cobra.Command{Use: "refresh [id]", Short: "Refresh stale memory entries (all or single entry)", Args: cobra.MaximumNArgs(1), RunE: r.runMemoryRefresh}
	memoryCmd.AddCommand(refreshCmd)

	root.AddCommand(memoryCmd)
}

func (r *Registry) runMemoryList(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	category, _ := cmd.Flags().GetString("category")
	category = strings.TrimSpace(strings.ToLower(category))
	tag, _ := cmd.Flags().GetString("tag")
	tag = strings.TrimSpace(tag)
	sourceType, _ := cmd.Flags().GetString("source-type")
	sourceType = strings.TrimSpace(strings.ToLower(sourceType))
	filePath, _ := cmd.Flags().GetString("file")
	filePath = strings.TrimSpace(filePath)
	staleOnly, _ := cmd.Flags().GetBool("stale")
	coveredBefore, _ := cmd.Flags().GetString("covered-before")
	coveredBefore = strings.TrimSpace(coveredBefore)
	jsonOut, _ := cmd.Flags().GetBool("json")

	if category != "" && !isValidMemoryCategory(category) {
		return fmt.Errorf("invalid --category %q (must be one of: pattern|pitfall|preference|convention|architecture|dependency)", category)
	}
	if sourceType != "" && !isValidMemorySourceType(sourceType) {
		return fmt.Errorf("invalid --source-type %q (must be one of: retro|explore)", sourceType)
	}

	store := memory.NewStore(db)
	entries, err := store.List(memory.ListOpts{
		Category:      category,
		Tag:           tag,
		SourceType:    sourceType,
		FilePath:      filePath,
		StaleOnly:     staleOnly,
		CoveredBefore: coveredBefore,
	})
	if err != nil {
		return fmt.Errorf("list memory: %w", err)
	}
	if jsonOut {
		payload, err := json.MarshalIndent(entries, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal memory entries: %w", err)
		}
		fmt.Println(string(payload))
		return nil
	}
	if len(entries) == 0 {
		fmt.Println("No memory entries.")
		return nil
	}

	for _, e := range entries {
		tags := "-"
		if len(e.Tags) > 0 {
			tags = strings.Join(e.Tags, ",")
		}
		stale := "no"
		if e.Stale {
			stale = "yes"
		}
		fmt.Printf("%s  [%s/%s]  conf=%.2f  stale=%s  covered=%s  tags=%s\n", short(e.ID), e.Category, e.SourceType, e.Confidence, stale, emptyDash(e.CoveredAtCommit), tags)
		fmt.Printf("  %s\n", e.Content)
		if len(e.FilePaths) > 0 {
			fmt.Printf("  files: %s\n", strings.Join(e.FilePaths, ", "))
		}
	}
	return nil
}

func (r *Registry) runMemoryShow(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	store := memory.NewStore(db)
	entry, err := store.Get(strings.TrimSpace(args[0]))
	if err != nil {
		return fmt.Errorf("get memory entry: %w", err)
	}

	usedByTasks, err := store.FindUsedByTasks(entry.ID)
	if err != nil {
		return fmt.Errorf("load entry lineage: %w", err)
	}
	supersedes, err := store.FindSupersededIDs(entry.ID)
	if err != nil {
		return fmt.Errorf("load supersession lineage: %w", err)
	}

	fmt.Printf("ID: %s\n", entry.ID)
	fmt.Printf("Source: %s\n", entry.SourceType)
	fmt.Printf("Category: %s\n", entry.Category)
	fmt.Printf("Confidence: %.2f\n", entry.Confidence)
	fmt.Printf("Stale: %s\n", map[bool]string{true: "yes", false: "no"}[entry.Stale])
	fmt.Printf("Covered at: %s\n", emptyDash(entry.CoveredAtCommit))
	tags := strings.Join(entry.Tags, ", ")
	if tags == "" {
		tags = "-"
	}
	fmt.Printf("Tags: %s\n", tags)
	if len(entry.FilePaths) == 0 {
		fmt.Println("Files: -")
	} else {
		fmt.Printf("Files: %s\n", strings.Join(entry.FilePaths, ", "))
	}
	fmt.Printf("Source task: %s\n", emptyDash(entry.SourceTaskID))
	fmt.Printf("Source interaction: %s\n", emptyDash(entry.SourceInteractionID))
	fmt.Printf("Provenance hash: %s\n", entry.ProvenanceHash)
	if len(supersedes) == 0 {
		fmt.Println("Supersedes: -")
	} else {
		fmt.Printf("Supersedes: %s\n", strings.Join(supersedes, ", "))
	}
	fmt.Printf("Superseded by: %s\n", emptyDash(entry.SupersededBy))
	fmt.Printf("Created: %s\n", entry.CreatedAt.Local().Format("2006-01-02 15:04:05"))
	fmt.Printf("Updated: %s\n", entry.UpdatedAt.Local().Format("2006-01-02 15:04:05"))
	fmt.Println("Used by tasks:")
	if len(usedByTasks) == 0 {
		fmt.Println("  - none")
	} else {
		for _, info := range usedByTasks {
			fmt.Printf("  - %s %q (%s)\n", short(info.TaskID), info.Title, info.Status)
		}
	}
	fmt.Println("Content:")
	fmt.Println(entry.Content)
	return nil
}

func (r *Registry) runMemorySearch(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	query := strings.TrimSpace(strings.Join(args, " "))
	if query == "" {
		return fmt.Errorf("query is required")
	}
	limit, _ := cmd.Flags().GetInt("limit")
	sourceType, _ := cmd.Flags().GetString("source-type")
	sourceType = strings.TrimSpace(strings.ToLower(sourceType))
	filePath, _ := cmd.Flags().GetString("file")
	filePath = strings.TrimSpace(filePath)
	jsonOut, _ := cmd.Flags().GetBool("json")
	if limit <= 0 {
		return fmt.Errorf("--limit must be > 0")
	}
	if sourceType != "" && !isValidMemorySourceType(sourceType) {
		return fmt.Errorf("invalid --source-type %q (must be one of: retro|explore)", sourceType)
	}

	store := memory.NewStore(db)
	entries, err := store.Search(query, limit)
	if err != nil {
		return fmt.Errorf("search memory: %w", err)
	}
	filtered := make([]*memory.Entry, 0, len(entries))
	for _, entry := range entries {
		if sourceType != "" && strings.TrimSpace(strings.ToLower(entry.SourceType)) != sourceType {
			continue
		}
		if filePath != "" && !containsString(entry.FilePaths, filePath) {
			continue
		}
		filtered = append(filtered, entry)
	}

	if jsonOut {
		payload, err := json.MarshalIndent(filtered, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal memory entries: %w", err)
		}
		fmt.Println(string(payload))
		return nil
	}
	if len(filtered) == 0 {
		fmt.Println("No matching memory entries.")
		return nil
	}

	for _, e := range filtered {
		fmt.Printf("%s  [%s/%s]  conf=%.2f\n", short(e.ID), e.Category, e.SourceType, e.Confidence)
		fmt.Printf("  %s\n", e.Content)
	}
	return nil
}

func (r *Registry) runMemoryEdit(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	id := strings.TrimSpace(args[0])
	fields := make(map[string]interface{})

	if cmd.Flags().Changed("content") {
		content, _ := cmd.Flags().GetString("content")
		content = strings.TrimSpace(content)
		if content == "" {
			return fmt.Errorf("--content cannot be empty")
		}
		fields["content"] = content
	}
	if cmd.Flags().Changed("confidence") {
		confidence, _ := cmd.Flags().GetFloat64("confidence")
		if confidence < 0 || confidence > 1 {
			return fmt.Errorf("--confidence must be between 0 and 1")
		}
		fields["confidence"] = confidence
	}
	if cmd.Flags().Changed("category") {
		category, _ := cmd.Flags().GetString("category")
		category = strings.TrimSpace(strings.ToLower(category))
		if !isValidMemoryCategory(category) {
			return fmt.Errorf("invalid --category %q (must be one of: pattern|pitfall|preference|convention)", category)
		}
		fields["category"] = category
	}
	if len(fields) == 0 {
		return fmt.Errorf("no fields provided (use --content, --confidence, or --category)")
	}

	store := memory.NewStore(db)
	if err := store.Update(id, fields); err != nil {
		return fmt.Errorf("update memory entry: %w", err)
	}

	fmt.Printf("Updated memory entry %s\n", short(id))
	return nil
}

func (r *Registry) runMemoryDelete(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	id := strings.TrimSpace(args[0])
	store := memory.NewStore(db)
	entry, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get memory entry: %w", err)
	}

	yes, _ := cmd.Flags().GetBool("yes")
	if !yes {
		confirm := false
		if err := huh.NewConfirm().
			Title(fmt.Sprintf("Delete memory entry %s?", short(entry.ID))).
			Description(entry.Content).
			Value(&confirm).
			Run(); err != nil {
			return err
		}
		if !confirm {
			fmt.Println("Aborted.")
			return nil
		}
	}

	if err := store.Delete(id); err != nil {
		return fmt.Errorf("delete memory entry: %w", err)
	}
	fmt.Printf("Deleted memory entry %s\n", short(entry.ID))
	return nil
}

func isValidMemoryCategory(category string) bool {
	switch strings.TrimSpace(strings.ToLower(category)) {
	case "pattern", "pitfall", "preference", "convention", "architecture", "dependency":
		return true
	default:
		return false
	}
}

func isValidMemorySourceType(sourceType string) bool {
	switch strings.TrimSpace(strings.ToLower(sourceType)) {
	case "retro", "explore":
		return true
	default:
		return false
	}
}

func (r *Registry) runMemorySync(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("resolve repo dir: %w", err)
	}
	store := memory.NewStore(db)
	syncer := newConfiguredMemorySyncer(cfg, store, db, repoDir)
	result, err := syncer.Sync()
	if err != nil {
		return fmt.Errorf("sync memory: %w", err)
	}

	fmt.Printf("Synced: %s -> %s (%d commits)\n", emptyDash(result.LastCommit), emptyDash(result.NewCommit), result.CommitCount)
	fmt.Printf("Affected files: %d\n", len(result.AffectedFiles))
	fmt.Printf("Flagged entries: %d\n", result.FlaggedEntries)
	fmt.Printf("Stale entries: %d\n", result.StaleEntries)
	fmt.Printf("Superseded: %d\n", result.SupersededCount)
	if len(result.Classifications) > 0 {
		fmt.Println("Classifications:")
		paths := make([]string, 0, len(result.Classifications))
		for path := range result.Classifications {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		for _, path := range paths {
			fmt.Printf("  %s: %s\n", path, result.Classifications[path])
		}
	}
	context := "unchanged"
	if result.ContextUpdated {
		context = "updated ✓"
	} else if result.ContextStale {
		context = "stale (re-explore recommended)"
	}
	fmt.Printf("Context: %s\n", context)
	return nil
}

func (r *Registry) runMemoryRefresh(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("resolve repo dir: %w", err)
	}

	entryID := ""
	if len(args) > 0 {
		entryID = strings.TrimSpace(args[0])
	}

	store := memory.NewStore(db)
	syncer := newConfiguredMemorySyncer(cfg, store, db, repoDir)
	result, err := syncer.Refresh(entryID)
	if err != nil {
		return fmt.Errorf("refresh memory: %w", err)
	}

	if result.EntryID != "" {
		fmt.Printf("Refreshed memory entry %s at %s (updated=%d, skipped=%d)\n", short(result.EntryID), result.Commit, result.Updated, result.Skipped)
		return nil
	}
	fmt.Printf("Refreshed stale memory entries at %s (updated=%d)\n", result.Commit, result.Updated)
	return nil
}

type memoryQueryResult struct {
	Entry       *memory.Entry       `json:"entry"`
	UsedByTasks []memory.UsedByTask `json:"used_by_tasks,omitempty"`
}

func (r *Registry) runMemoryQuery(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	query := strings.TrimSpace(strings.Join(args, " "))
	if query == "" {
		return fmt.Errorf("query is required")
	}
	limit, _ := cmd.Flags().GetInt("limit")
	jsonOut, _ := cmd.Flags().GetBool("json")
	if limit <= 0 {
		return fmt.Errorf("--limit must be > 0")
	}

	store := memory.NewStore(db)
	entries, err := store.Search(query, limit)
	if err != nil {
		return fmt.Errorf("query memory: %w", err)
	}

	enriched := make([]memoryQueryResult, 0, len(entries))
	for _, entry := range entries {
		usedBy, lineageErr := store.FindUsedByTasks(entry.ID)
		if lineageErr != nil {
			return fmt.Errorf("load memory lineage: %w", lineageErr)
		}
		enriched = append(enriched, memoryQueryResult{
			Entry:       entry,
			UsedByTasks: usedBy,
		})
	}

	if jsonOut {
		payload, err := json.MarshalIndent(enriched, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal query results: %w", err)
		}
		fmt.Println(string(payload))
		return nil
	}
	if len(enriched) == 0 {
		fmt.Println("No matching memory entries.")
		return nil
	}

	fmt.Printf("Found %d relevant entries:\n\n", len(enriched))
	for idx, item := range enriched {
		entry := item.Entry
		fmt.Printf("%d. [%s] %s (confidence: %.2f, stale: %v)\n", idx+1, entry.SourceType, entry.Content, entry.Confidence, entry.Stale)
		if len(entry.FilePaths) > 0 {
			fmt.Printf("   Files: %s\n", strings.Join(entry.FilePaths, ", "))
		}
		fmt.Printf("   Covered at: %s\n", emptyDash(entry.CoveredAtCommit))
		if len(item.UsedByTasks) > 0 {
			fmt.Println("   Used by tasks:")
			for _, info := range item.UsedByTasks {
				fmt.Printf("   - %s %q (%s)\n", short(info.TaskID), info.Title, info.Status)
			}
		}
		fmt.Println()
	}
	return nil
}

func containsString(items []string, needle string) bool {
	needle = strings.TrimSpace(needle)
	if needle == "" {
		return false
	}
	for _, item := range items {
		if strings.TrimSpace(item) == needle {
			return true
		}
	}
	return false
}

func emptyDash(v string) string {
	if strings.TrimSpace(v) == "" {
		return "-"
	}
	return v
}
