package commands

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/knowledge"
	"github.com/spf13/cobra"
)

func RegisterKnowledge(root *cobra.Command, r *Registry) {
	knowledgeCmd := &cobra.Command{
		Use:   "knowledge",
		Short: "Manage learned knowledge entries",
		RunE:  r.runKnowledgeList,
	}

	listCmd := &cobra.Command{Use: "list", Short: "List knowledge entries", RunE: r.runKnowledgeList}
	listCmd.Flags().String("category", "", "Filter by category: pattern|pitfall|preference|convention")
	listCmd.Flags().String("tag", "", "Filter by tag")
	listCmd.Flags().Bool("json", false, "Output as JSON")
	knowledgeCmd.AddCommand(listCmd)

	showCmd := &cobra.Command{Use: "show <id>", Short: "Show a knowledge entry", Args: cobra.ExactArgs(1), RunE: r.runKnowledgeShow}
	knowledgeCmd.AddCommand(showCmd)

	searchCmd := &cobra.Command{Use: "search <query>", Short: "Search knowledge entries", Args: cobra.MinimumNArgs(1), RunE: r.runKnowledgeSearch}
	searchCmd.Flags().Int("limit", 10, "Maximum results")
	searchCmd.Flags().Bool("json", false, "Output as JSON")
	knowledgeCmd.AddCommand(searchCmd)

	editCmd := &cobra.Command{Use: "edit <id>", Short: "Edit a knowledge entry", Args: cobra.ExactArgs(1), RunE: r.runKnowledgeEdit}
	editCmd.Flags().String("content", "", "Updated content")
	editCmd.Flags().Float64("confidence", 0, "Updated confidence (0..1)")
	editCmd.Flags().String("category", "", "Updated category: pattern|pitfall|preference|convention")
	knowledgeCmd.AddCommand(editCmd)

	deleteCmd := &cobra.Command{Use: "delete <id>", Short: "Delete a knowledge entry", Args: cobra.ExactArgs(1), RunE: r.runKnowledgeDelete}
	deleteCmd.Flags().BoolP("yes", "y", false, "Skip confirmation")
	knowledgeCmd.AddCommand(deleteCmd)

	root.AddCommand(knowledgeCmd)
}

func (r *Registry) runKnowledgeList(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	category, _ := cmd.Flags().GetString("category")
	category = strings.TrimSpace(strings.ToLower(category))
	tag, _ := cmd.Flags().GetString("tag")
	tag = strings.TrimSpace(tag)
	jsonOut, _ := cmd.Flags().GetBool("json")

	if category != "" && !isValidKnowledgeCategory(category) {
		return fmt.Errorf("invalid --category %q (must be one of: pattern|pitfall|preference|convention)", category)
	}

	store := knowledge.NewStore(db)
	entries, err := store.List(knowledge.ListOpts{Category: category, Tag: tag})
	if err != nil {
		return fmt.Errorf("list knowledge: %w", err)
	}
	if jsonOut {
		payload, err := json.MarshalIndent(entries, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal knowledge entries: %w", err)
		}
		fmt.Println(string(payload))
		return nil
	}
	if len(entries) == 0 {
		fmt.Println("No knowledge entries.")
		return nil
	}

	for _, e := range entries {
		tags := "-"
		if len(e.Tags) > 0 {
			tags = strings.Join(e.Tags, ",")
		}
		fmt.Printf("%s  [%s]  conf=%.2f  tags=%s\n", short(e.ID), e.Category, e.Confidence, tags)
		fmt.Printf("  %s\n", e.Content)
	}
	return nil
}

func (r *Registry) runKnowledgeShow(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	store := knowledge.NewStore(db)
	entry, err := store.Get(strings.TrimSpace(args[0]))
	if err != nil {
		return fmt.Errorf("get knowledge entry: %w", err)
	}

	fmt.Printf("ID: %s\n", entry.ID)
	fmt.Printf("Category: %s\n", entry.Category)
	fmt.Printf("Confidence: %.2f\n", entry.Confidence)
	tags := strings.Join(entry.Tags, ", ")
	if tags == "" {
		tags = "-"
	}
	fmt.Printf("Tags: %s\n", tags)
	fmt.Printf("Source task: %s\n", emptyDash(entry.SourceTaskID))
	fmt.Printf("Source interaction: %s\n", emptyDash(entry.SourceInteractionID))
	fmt.Printf("Provenance hash: %s\n", entry.ProvenanceHash)
	fmt.Printf("Superseded by: %s\n", emptyDash(entry.SupersededBy))
	fmt.Printf("Created: %s\n", entry.CreatedAt.Local().Format("2006-01-02 15:04:05"))
	fmt.Printf("Updated: %s\n", entry.UpdatedAt.Local().Format("2006-01-02 15:04:05"))
	fmt.Println("Content:")
	fmt.Println(entry.Content)
	return nil
}

func (r *Registry) runKnowledgeSearch(cmd *cobra.Command, args []string) error {
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

	store := knowledge.NewStore(db)
	entries, err := store.Search(query, limit)
	if err != nil {
		return fmt.Errorf("search knowledge: %w", err)
	}

	if jsonOut {
		payload, err := json.MarshalIndent(entries, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal knowledge entries: %w", err)
		}
		fmt.Println(string(payload))
		return nil
	}
	if len(entries) == 0 {
		fmt.Println("No matching knowledge entries.")
		return nil
	}

	for _, e := range entries {
		fmt.Printf("%s  [%s]  conf=%.2f\n", short(e.ID), e.Category, e.Confidence)
		fmt.Printf("  %s\n", e.Content)
	}
	return nil
}

func (r *Registry) runKnowledgeEdit(cmd *cobra.Command, args []string) error {
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
		if !isValidKnowledgeCategory(category) {
			return fmt.Errorf("invalid --category %q (must be one of: pattern|pitfall|preference|convention)", category)
		}
		fields["category"] = category
	}
	if len(fields) == 0 {
		return fmt.Errorf("no fields provided (use --content, --confidence, or --category)")
	}

	store := knowledge.NewStore(db)
	if err := store.Update(id, fields); err != nil {
		return fmt.Errorf("update knowledge entry: %w", err)
	}

	fmt.Printf("Updated knowledge entry %s\n", short(id))
	return nil
}

func (r *Registry) runKnowledgeDelete(cmd *cobra.Command, args []string) error {
	db, _, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	id := strings.TrimSpace(args[0])
	store := knowledge.NewStore(db)
	entry, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get knowledge entry: %w", err)
	}

	yes, _ := cmd.Flags().GetBool("yes")
	if !yes {
		confirm := false
		if err := huh.NewConfirm().
			Title(fmt.Sprintf("Delete knowledge entry %s?", short(entry.ID))).
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
		return fmt.Errorf("delete knowledge entry: %w", err)
	}
	fmt.Printf("Deleted knowledge entry %s\n", short(entry.ID))
	return nil
}

func isValidKnowledgeCategory(category string) bool {
	switch strings.TrimSpace(strings.ToLower(category)) {
	case "pattern", "pitfall", "preference", "convention":
		return true
	default:
		return false
	}
}

func emptyDash(v string) string {
	if strings.TrimSpace(v) == "" {
		return "-"
	}
	return v
}
