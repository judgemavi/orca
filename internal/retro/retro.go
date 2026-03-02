// Package retro extracts reusable knowledge entries from task outcomes.
package retro

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/knowledge"
	"github.com/jasjeetmavi/orca/internal/llm"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

type retroEntry struct {
	Content    string   `json:"content"`
	Category   string   `json:"category"`
	Tags       []string `json:"tags"`
	Confidence float64  `json:"confidence"`
	Supersedes string   `json:"supersedes,omitempty"`
}

type planUsage struct {
	UsedKnowledgeIDs     []string `json:"used_knowledge_ids"`
	UsedProvenanceHashes []string `json:"used_provenance_hashes"`
}

type retroQuality struct {
	TaskID               string   `json:"task_id"`
	ProvenanceHash       string   `json:"provenance_hash"`
	ExtractedCount       int      `json:"extracted_count"`
	CreatedCount         int      `json:"created_count"`
	SkippedCount         int      `json:"skipped_count"`
	DuplicateProvenance  bool     `json:"duplicate_provenance"`
	CreatedEntryIDs      []string `json:"created_entry_ids,omitempty"`
	UsedKnowledgeIDs     []string `json:"used_knowledge_ids,omitempty"`
	UsedProvenanceHashes []string `json:"used_provenance_hashes,omitempty"`
	Error                string   `json:"error,omitempty"`
}

type RetroResult struct {
	TaskID              string   `json:"task_id"`
	ProvenanceHash      string   `json:"provenance_hash"`
	ExtractedCount      int      `json:"extracted_count"`
	CreatedCount        int      `json:"created_count"`
	SkippedCount        int      `json:"skipped_count"`
	DuplicateProvenance bool     `json:"duplicate_provenance"`
	CreatedEntryIDs     []string `json:"created_entry_ids,omitempty"`
}

type RetroGenerator struct {
	toolName       string
	driver         driver.Driver
	model          string
	timeout        time.Duration
	repoDir        string
	knowledgeStore *knowledge.Store
	taskStore      *task.Store
	interactions   *interaction.Store
}

func New(
	toolName string,
	d driver.Driver,
	model string,
	timeout time.Duration,
	repoDir string,
	knowledgeStore *knowledge.Store,
	taskStore *task.Store,
	interactions ...*interaction.Store,
) *RetroGenerator {
	var store *interaction.Store
	if len(interactions) > 0 {
		store = interactions[0]
	}
	return &RetroGenerator{
		toolName:       toolName,
		driver:         d,
		model:          model,
		timeout:        timeout,
		repoDir:        repoDir,
		knowledgeStore: knowledgeStore,
		taskStore:      taskStore,
		interactions:   store,
	}
}

func (g *RetroGenerator) Run(taskID string) (*RetroResult, error) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return nil, fmt.Errorf("task id required")
	}
	if g.taskStore == nil {
		return nil, fmt.Errorf("task store required")
	}
	if g.knowledgeStore == nil {
		return nil, fmt.Errorf("knowledge store required")
	}
	if g.interactions == nil {
		return nil, fmt.Errorf("interaction store required")
	}

	tk, err := g.taskStore.Get(taskID)
	if err != nil {
		return nil, fmt.Errorf("load task: %w", err)
	}
	taskInteractions, err := g.interactions.List(taskID)
	if err != nil {
		return nil, fmt.Errorf("list task interactions: %w", err)
	}

	planInteraction := latestCompletedPlanInteraction(taskInteractions)
	planText := ""
	usedKnowledgeIDs := []string{}
	usedProvenanceHashes := []string{}
	if planInteraction != nil {
		planText = strings.TrimSpace(planInteraction.Diff)
		usedKnowledgeIDs, usedProvenanceHashes = extractPlanUsage(planInteraction.QualityJSON)
	}
	runDiffs := collectRunDiffs(taskInteractions)
	reviewFeedback := collectReviewFeedback(taskInteractions)
	usedEntries, err := loadKnowledgeEntries(g.knowledgeStore, usedKnowledgeIDs)
	if err != nil {
		return nil, fmt.Errorf("load used knowledge entries: %w", err)
	}

	searchQuery := buildSearchQuery(tk.Title, tk.Description, planText, runDiffs, reviewFeedback)
	relatedEntries := []*knowledge.Entry{}
	if searchQuery != "" {
		relatedEntries, err = g.knowledgeStore.SearchExcluding(searchQuery, 10, usedProvenanceHashes)
		if err != nil {
			relatedEntries = nil
		}
	}

	prompt := buildRetroPrompt(
		tk.Title,
		tk.Description,
		planText,
		runDiffs,
		reviewFeedback,
		usedEntries,
		usedKnowledgeIDs,
		usedProvenanceHashes,
		relatedEntries,
	)
	provenanceHash := retroProvenanceHash(planText, runDiffs, reviewFeedback)

	adapter := worker.NewAdapter(g.driver, g.model, g.timeout)
	var (
		exitCode      = -1
		stderr        string
		output        string
		parseErr      error
		createErr     error
		interactionID string
		entries       []retroEntry
		result        = &RetroResult{
			TaskID:         taskID,
			ProvenanceHash: provenanceHash,
		}
	)

	taskRef := taskID
	_, err = interaction.RunWithTracking(
		g.interactions,
		&taskRef,
		interaction.PhaseRetro,
		g.toolName,
		adapter,
		func() (*worker.Result, error) {
			return adapter.Execute(context.Background(), interaction.PhaseRetro, prompt, g.repoDir)
		},
		interaction.WithOnBegin(func(w *interaction.Writer) {
			interactionID = w.ID()
		}),
		interaction.WithAfterRun(func(runResult *worker.Result, _ error) {
			if runResult != nil {
				output = runResult.Stdout
				exitCode = runResult.ExitCode
				stderr = runResult.Stderr
			}
			parseErr = llm.ExtractJSON(output, &entries)
			if parseErr != nil {
				return
			}
			result.ExtractedCount = len(entries)

			duplicate, err := g.knowledgeStore.HasProvenanceHash(provenanceHash)
			if err != nil {
				createErr = fmt.Errorf("check duplicate provenance hash: %w", err)
				return
			}
			if duplicate {
				result.DuplicateProvenance = true
				result.SkippedCount = len(entries)
				return
			}

			for i, entry := range entries {
				entry = normalizeRetroEntry(entry)
				if entry.Content == "" {
					createErr = fmt.Errorf("entry %d has empty content", i)
					return
				}
				if entry.Category == "" {
					createErr = fmt.Errorf("entry %d has empty category", i)
					return
				}

				created := &knowledge.Entry{
					Content:             entry.Content,
					Category:            entry.Category,
					Tags:                entry.Tags,
					SourceTaskID:        taskID,
					SourceInteractionID: interactionID,
					Confidence:          entry.Confidence,
					ProvenanceHash:      provenanceHash,
				}
				if err := g.knowledgeStore.Create(created); err != nil {
					createErr = fmt.Errorf("create knowledge entry: %w", err)
					return
				}
				result.CreatedCount++
				result.CreatedEntryIDs = append(result.CreatedEntryIDs, created.ID)

				if entry.Supersedes != "" {
					if err := g.knowledgeStore.Supersede(entry.Supersedes, created.ID); err != nil {
						createErr = fmt.Errorf("supersede knowledge entry %s: %w", entry.Supersedes, err)
						return
					}
				}
			}
		}),
		interaction.WithFinishFn(func(runResult *worker.Result, runErr error) (string, []interaction.FinishOption) {
			status := "completed"
			opts := []interaction.FinishOption{}
			if runResult != nil {
				opts = append(opts, interaction.WithCost(runResult.InputTokens, runResult.OutputTokens, runResult.TotalCost))
			}

			quality := retroQuality{
				TaskID:               taskID,
				ProvenanceHash:       provenanceHash,
				ExtractedCount:       result.ExtractedCount,
				CreatedCount:         result.CreatedCount,
				SkippedCount:         result.SkippedCount,
				DuplicateProvenance:  result.DuplicateProvenance,
				CreatedEntryIDs:      result.CreatedEntryIDs,
				UsedKnowledgeIDs:     usedKnowledgeIDs,
				UsedProvenanceHashes: usedProvenanceHashes,
			}

			if runErr != nil {
				status = "failed"
				opts = append(opts, interaction.WithError(runErr.Error()))
				quality.Error = runErr.Error()
			} else if exitCode != 0 {
				status = "failed"
				errMsg := fmt.Sprintf("retro generator exited %d: %s", exitCode, stderr)
				opts = append(opts, interaction.WithError(errMsg))
				quality.Error = errMsg
			} else if parseErr != nil {
				status = "failed"
				errMsg := fmt.Sprintf("parse retro JSON: %v", parseErr)
				opts = append(opts, interaction.WithError(errMsg))
				quality.Error = errMsg
			} else if createErr != nil {
				status = "failed"
				opts = append(opts, interaction.WithError(createErr.Error()))
				quality.Error = createErr.Error()
			}

			qualityBytes, _ := json.Marshal(quality)
			opts = append(opts, interaction.WithQuality(string(qualityBytes)))
			return status, opts
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("execute retro generator: %w", err)
	}
	if exitCode != 0 {
		return nil, fmt.Errorf("retro generator exited %d: %s", exitCode, stderr)
	}
	if parseErr != nil {
		return nil, fmt.Errorf("parse retro JSON: %w\nraw output:\n%s", parseErr, output)
	}
	if createErr != nil {
		return nil, createErr
	}

	return result, nil
}

func buildRetroPrompt(
	title, description, planText, runDiffs, reviewFeedback string,
	usedEntries []*knowledge.Entry,
	usedKnowledgeIDs, usedProvenanceHashes []string,
	relatedEntries []*knowledge.Entry,
) string {
	return fmt.Sprintf(
		prompts.Retro,
		strings.TrimSpace(title),
		strings.TrimSpace(description),
		emptyFallback(planText),
		emptyFallback(runDiffs),
		emptyFallback(reviewFeedback),
		formatKnowledgeEntries(usedEntries),
		formatList(usedKnowledgeIDs),
		formatList(usedProvenanceHashes),
		formatKnowledgeEntries(relatedEntries),
	)
}

func parseRetroEntries(raw string) ([]retroEntry, error) {
	var entries []retroEntry
	if err := llm.ExtractJSON(raw, &entries); err != nil {
		return nil, err
	}
	for i := range entries {
		entries[i] = normalizeRetroEntry(entries[i])
	}
	return entries, nil
}

func normalizeRetroEntry(in retroEntry) retroEntry {
	out := retroEntry{
		Content:    strings.TrimSpace(in.Content),
		Category:   strings.ToLower(strings.TrimSpace(in.Category)),
		Tags:       normalizeList(in.Tags),
		Confidence: in.Confidence,
		Supersedes: strings.TrimSpace(in.Supersedes),
	}
	return out
}

func latestCompletedPlanInteraction(interactions []interaction.Interaction) *interaction.Interaction {
	for i := range interactions {
		in := interactions[i]
		if in.Phase == interaction.PhasePlan && in.Status == "completed" {
			return &in
		}
	}
	return nil
}

func collectRunDiffs(interactions []interaction.Interaction) string {
	diffs := make([]string, 0)
	for i := len(interactions) - 1; i >= 0; i-- {
		in := interactions[i]
		if in.Phase != interaction.PhaseRun || in.Status != "completed" {
			continue
		}
		diff := strings.TrimSpace(in.Diff)
		if diff == "" {
			continue
		}
		diffs = append(diffs, diff)
	}
	return strings.Join(diffs, "\n\n---\n\n")
}

func collectReviewFeedback(interactions []interaction.Interaction) string {
	sections := make([]string, 0)
	for i := len(interactions) - 1; i >= 0; i-- {
		in := interactions[i]
		if in.Status != "completed" {
			continue
		}
		if in.Phase != interaction.PhaseReview && in.Phase != "ai_review" {
			continue
		}
		parts := make([]string, 0, 3)
		if quality := strings.TrimSpace(in.QualityJSON); quality != "" {
			parts = append(parts, "quality_json:\n"+quality)
		}
		if diff := strings.TrimSpace(in.Diff); diff != "" {
			parts = append(parts, "diff:\n"+diff)
		}
		if errText := strings.TrimSpace(in.Error); errText != "" {
			parts = append(parts, "error:\n"+errText)
		}
		if len(parts) == 0 {
			continue
		}
		sections = append(sections, strings.Join(parts, "\n\n"))
	}
	return strings.Join(sections, "\n\n---\n\n")
}

func extractPlanUsage(raw string) ([]string, []string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var usage planUsage
	if err := json.Unmarshal([]byte(raw), &usage); err != nil {
		return nil, nil
	}
	return normalizeList(usage.UsedKnowledgeIDs), normalizeList(usage.UsedProvenanceHashes)
}

func retroProvenanceHash(planText, runDiffs, reviewFeedback string) string {
	sum := sha256.Sum256([]byte(planText + "\n---\n" + runDiffs + "\n---\n" + reviewFeedback))
	return hex.EncodeToString(sum[:])
}

func emptyFallback(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "(none)"
	}
	return s
}

func formatList(items []string) string {
	items = normalizeList(items)
	if len(items) == 0 {
		return "(none)"
	}
	var b strings.Builder
	for _, item := range items {
		b.WriteString("- ")
		b.WriteString(item)
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func formatKnowledgeEntries(entries []*knowledge.Entry) string {
	if len(entries) == 0 {
		return "(none)"
	}

	var b strings.Builder
	for _, entry := range entries {
		if entry == nil {
			continue
		}
		content := strings.TrimSpace(entry.Content)
		if content == "" {
			continue
		}
		fmt.Fprintf(
			&b,
			"- [%s] [%s conf=%.2f] %s",
			strings.TrimSpace(entry.ID),
			strings.TrimSpace(entry.Category),
			entry.Confidence,
			content,
		)
		if len(entry.Tags) > 0 {
			fmt.Fprintf(&b, " (tags: %s)", strings.Join(entry.Tags, ", "))
		}
		b.WriteString("\n")
	}

	out := strings.TrimSpace(b.String())
	if out == "" {
		return "(none)"
	}
	return out
}

func loadKnowledgeEntries(store *knowledge.Store, ids []string) ([]*knowledge.Entry, error) {
	ids = normalizeList(ids)
	if len(ids) == 0 {
		return nil, nil
	}

	entries := make([]*knowledge.Entry, 0, len(ids))
	for _, id := range ids {
		entry, err := store.Get(id)
		if err != nil {
			// Ignore missing entries so retro still proceeds if knowledge was deleted.
			if strings.Contains(strings.ToLower(err.Error()), "not found") {
				continue
			}
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func normalizeList(items []string) []string {
	if len(items) == 0 {
		return nil
	}
	out := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func buildSearchQuery(parts ...string) string {
	raw := strings.ToLower(strings.Join(parts, " "))
	tokens := strings.FieldsFunc(raw, func(r rune) bool {
		switch {
		case r >= 'a' && r <= 'z':
			return false
		case r >= '0' && r <= '9':
			return false
		case r == '_':
			return false
		default:
			return true
		}
	})
	return strings.Join(normalizeList(tokens), " ")
}
