// refresh.go contains stale-memory refresh logic and LLM-backed re-extraction.
package memory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/llm"
	"github.com/jasjeetmavi/orca/internal/worker"
)

type RefreshResult struct {
	EntryID string `json:"entry_id,omitempty"`
	Updated int    `json:"updated"`
	Skipped int    `json:"skipped"`
	Commit  string `json:"commit"`
}

// Refresher updates stale entries by checking git changes and optionally using an LLM.
type Refresher struct {
	syncer *Syncer
}

func NewRefresher(syncer *Syncer) *Refresher {
	return &Refresher{syncer: syncer}
}

func (s *Syncer) Refresh(entryID string) (*RefreshResult, error) {
	return NewRefresher(s).Refresh(entryID)
}

func (r *Refresher) Refresh(entryID string) (*RefreshResult, error) {
	if r == nil || r.syncer == nil {
		return nil, fmt.Errorf("syncer required")
	}
	syncer := r.syncer
	if syncer.store == nil {
		return nil, fmt.Errorf("memory store required")
	}
	if strings.TrimSpace(syncer.repoDir) == "" {
		return nil, fmt.Errorf("repo dir required")
	}

	head, err := syncer.gitOutput("rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	head = strings.TrimSpace(head)
	if head == "" {
		return nil, fmt.Errorf("empty HEAD commit")
	}

	result := &RefreshResult{
		EntryID: strings.TrimSpace(entryID),
		Commit:  head,
	}
	if result.EntryID != "" {
		entry, err := syncer.store.Get(result.EntryID)
		if err != nil {
			return nil, err
		}
		updated, refreshErr := r.refreshEntry(entry, head)
		if refreshErr != nil {
			return nil, refreshErr
		}
		if updated {
			result.Updated = 1
		} else {
			result.Skipped = 1
		}
		return result, nil
	}

	entries, err := syncer.store.FindStaleEntries()
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		updated, refreshErr := r.refreshEntry(entry, head)
		if refreshErr != nil {
			result.Skipped++
			continue
		}
		if updated {
			result.Updated++
		} else {
			result.Skipped++
		}
	}
	return result, nil
}

func (r *Refresher) refreshEntry(entry *Entry, head string) (bool, error) {
	syncer := r.syncer
	if entry == nil {
		return false, nil
	}
	if !entry.Stale {
		return false, nil
	}

	if !r.hasEntryChanges(entry, head) {
		if err := syncer.store.Update(entry.ID, UpdateFields{
			Stale:           Ptr(false),
			CoveredAtCommit: Ptr(head),
		}); err != nil {
			return false, err
		}
		return true, nil
	}

	// If LLM refresh isn't configured, keep stale entries unchanged.
	if syncer.driver == nil || strings.TrimSpace(syncer.model) == "" {
		return false, nil
	}

	updated, filePaths, err := r.refreshEntryWithLLM(entry, head)
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(updated) == "" {
		if err := syncer.store.Update(entry.ID, UpdateFields{
			Stale:           Ptr(false),
			CoveredAtCommit: Ptr(head),
		}); err != nil {
			return false, err
		}
		return true, nil
	}

	nextFilePaths := entry.FilePaths
	if len(filePaths) > 0 {
		nextFilePaths = filePaths
	}

	nextEntry := &Entry{
		Content:             strings.TrimSpace(updated),
		Category:            entry.Category,
		Tags:                entry.Tags,
		SourceTaskID:        entry.SourceTaskID,
		SourceInteractionID: entry.SourceInteractionID,
		SourceType:          entry.SourceType,
		FilePaths:           nextFilePaths,
		CoveredAtCommit:     head,
		Confidence:          entry.Confidence,
		ProvenanceHash:      refreshProvenanceHash(entry, updated, head),
	}
	if nextEntry.Confidence <= 0 {
		nextEntry.Confidence = 0.95
	}
	if err := syncer.store.Create(nextEntry); err != nil {
		return false, err
	}
	if err := syncer.store.Supersede(entry.ID, nextEntry.ID); err != nil {
		return false, err
	}
	return true, nil
}

func (r *Refresher) hasEntryChanges(entry *Entry, head string) bool {
	if entry == nil || len(entry.FilePaths) == 0 {
		return false
	}
	base := strings.TrimSpace(entry.CoveredAtCommit)
	if base == "" || base == strings.TrimSpace(head) {
		return false
	}
	args := []string{"diff", "--name-only", base + ".." + strings.TrimSpace(head), "--"}
	args = append(args, entry.FilePaths...)
	out, err := r.syncer.gitOutput(args...)
	if err != nil {
		return true
	}
	return strings.TrimSpace(out) != ""
}

type refreshLLMOutput struct {
	Valid            bool     `json:"valid"`
	UpdatedContent   string   `json:"updated_content"`
	UpdatedFilePaths []string `json:"updated_file_paths"`
}

func (r *Refresher) refreshEntryWithLLM(entry *Entry, head string) (string, []string, error) {
	syncer := r.syncer
	base := strings.TrimSpace(entry.CoveredAtCommit)
	if base == "" {
		base = head
	}

	diff := ""
	if len(entry.FilePaths) > 0 && base != head {
		args := []string{"diff", base + ".." + head, "--"}
		args = append(args, entry.FilePaths...)
		out, err := syncer.gitOutput(args...)
		if err == nil {
			diff = strings.TrimSpace(out)
		}
	}
	if syncer.maxDiffBytes > 0 && len(diff) > syncer.maxDiffBytes {
		return "", nil, nil
	}

	content := r.collectCurrentFileContent(entry.FilePaths)
	prompt := buildRefreshPrompt(entry, diff, content)
	adapter := worker.NewAdapter(syncer.driver, syncer.model, syncer.timeout)
	runResult, runErr := adapter.Execute(context.Background(), "memory_refresh", prompt, syncer.repoDir)
	if runErr != nil || runResult == nil || runResult.ExitCode != 0 {
		return "", nil, fmt.Errorf("refresh entry %s: llm run failed", entry.ID)
	}

	response := strings.TrimSpace(runResult.Stdout)
	if response == "" {
		return "", nil, nil
	}
	var payload refreshLLMOutput
	found, err := llm.TryExtractJSON(response, &payload)
	if err != nil || !found {
		return "", nil, fmt.Errorf("refresh entry %s: parse llm output", entry.ID)
	}
	if payload.Valid {
		return "", nil, nil
	}
	return strings.TrimSpace(payload.UpdatedContent), normalizeChangedFilePaths(payload.UpdatedFilePaths), nil
}

func (r *Refresher) collectCurrentFileContent(paths []string) string {
	syncer := r.syncer
	if len(paths) == 0 {
		return ""
	}
	var blocks []string
	for _, path := range normalizeChangedFilePaths(paths) {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		out, err := syncer.gitOutput("show", "HEAD:"+path)
		if err != nil {
			continue
		}
		if syncer.maxDiffBytes > 0 && len(out) > syncer.maxDiffBytes/2 {
			out = out[:syncer.maxDiffBytes/2]
		}
		blocks = append(blocks, "### "+path+"\n"+strings.TrimSpace(out))
	}
	return strings.TrimSpace(strings.Join(blocks, "\n\n"))
}

func buildRefreshPrompt(entry *Entry, diff, currentFiles string) string {
	type entryPayload struct {
		Content   string   `json:"content"`
		Category  string   `json:"category"`
		Source    string   `json:"source_type"`
		FilePaths []string `json:"file_paths"`
	}
	raw, _ := json.MarshalIndent(entryPayload{
		Content:   strings.TrimSpace(entry.Content),
		Category:  strings.TrimSpace(entry.Category),
		Source:    strings.TrimSpace(entry.SourceType),
		FilePaths: normalizeChangedFilePaths(entry.FilePaths),
	}, "", "  ")
	return strings.TrimSpace(fmt.Sprintf(`
You are refreshing a stale memory entry.

Return valid JSON only using this schema:
{
  "valid": boolean,
  "updated_content": string,
  "updated_file_paths": string[]
}

Rules:
- If the entry is still accurate, return {"valid": true, "updated_content": "", "updated_file_paths": []}
- If it is outdated, return {"valid": false, ...} with concise updated content.
- Keep content self-contained and specific to the codebase.
- Use repo-relative file paths only.

Current entry:
%s

Diff since it was last covered:
%s

Current file content:
%s
`, string(raw), emptyIfBlank(diff), emptyIfBlank(currentFiles)))
}

func refreshProvenanceHash(entry *Entry, updatedContent, head string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(entry.ProvenanceHash),
		strings.TrimSpace(updatedContent),
		strings.TrimSpace(head),
	}, "\n---\n")))
	return hex.EncodeToString(sum[:])
}
