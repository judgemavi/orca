package memory

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

const (
	metaLastSyncedCommit    = "last_synced_commit"
	metaExploreContextStale = "explore_context_stale"
	exploreContextRowID     = 1
)

var syncStructuralFiles = map[string]struct{}{
	"go.mod":           {},
	"go.sum":           {},
	"package.json":     {},
	"pnpm-lock.yaml":   {},
	"yarn.lock":        {},
	"bun.lock":         {},
	"bun.lockb":        {},
	"Cargo.toml":       {},
	"Cargo.lock":       {},
	"pyproject.toml":   {},
	"requirements.txt": {},
}

type Syncer struct {
	store   *Store
	db      *sql.DB
	repoDir string

	toolName string
	driver   driver.Driver
	model    string
	timeout  time.Duration

	maxDiffBytes int
}

type SyncResult struct {
	LastCommit      string            `json:"last_commit"`
	NewCommit       string            `json:"new_commit"`
	CommitCount     int               `json:"commit_count"`
	AffectedFiles   []string          `json:"affected_files"`
	FlaggedEntries  int               `json:"flagged_entries"`
	StaleEntries    int               `json:"stale_entries"`
	SupersededCount int               `json:"superseded_count"`
	Classifications map[string]string `json:"classifications"`
	ContextUpdated  bool              `json:"context_updated"`
	ContextStale    bool              `json:"context_stale"`
}

type SyncStatus struct {
	LastSyncedCommit string `json:"last_synced_commit"`
	CurrentCommit    string `json:"current_commit"`
	SyncNeeded       bool   `json:"sync_needed"`
	CommitsBehind    int    `json:"commits_behind"`
	ContextStale     bool   `json:"context_stale"`
}

type RefreshResult struct {
	EntryID string `json:"entry_id,omitempty"`
	Updated int    `json:"updated"`
	Skipped int    `json:"skipped"`
	Commit  string `json:"commit"`
}

func NewSyncer(store *Store, db *sql.DB, repoDir, toolName string, d driver.Driver, model string, timeout time.Duration) *Syncer {
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	return &Syncer{
		store:        store,
		db:           db,
		repoDir:      repoDir,
		toolName:     strings.TrimSpace(toolName),
		driver:       d,
		model:        strings.TrimSpace(model),
		timeout:      timeout,
		maxDiffBytes: 200_000,
	}
}

func (s *Syncer) Sync() (*SyncResult, error) {
	if s.store == nil {
		return nil, fmt.Errorf("memory store required")
	}
	if s.db == nil {
		return nil, fmt.Errorf("db required")
	}
	if strings.TrimSpace(s.repoDir) == "" {
		return nil, fmt.Errorf("repo dir required")
	}

	lastCommit, err := s.GetLastSyncedCommit()
	if err != nil {
		return nil, err
	}
	head, err := s.gitOutput("rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	head = strings.TrimSpace(head)
	if head == "" {
		return nil, fmt.Errorf("empty HEAD commit")
	}

	result := &SyncResult{
		LastCommit:      lastCommit,
		NewCommit:       head,
		CommitCount:     0,
		AffectedFiles:   []string{},
		FlaggedEntries:  0,
		StaleEntries:    0,
		SupersededCount: 0,
		Classifications: map[string]string{},
	}

	if strings.TrimSpace(lastCommit) == "" {
		if err := s.SetLastSyncedCommit(head); err != nil {
			return nil, err
		}
		result.ContextStale, _ = s.GetContextStaleFlag()
		return result, nil
	}
	if lastCommit == head {
		result.ContextStale, _ = s.GetContextStaleFlag()
		return result, nil
	}

	commitCountRaw, err := s.gitOutput("rev-list", "--count", lastCommit+".."+head)
	if err != nil {
		return nil, err
	}
	commitCountRaw = strings.TrimSpace(commitCountRaw)
	if commitCountRaw != "" {
		commitCount, parseErr := strconv.Atoi(commitCountRaw)
		if parseErr != nil {
			return nil, fmt.Errorf("parse commit count %q: %w", commitCountRaw, parseErr)
		}
		result.CommitCount = commitCount
	}

	changedFilesRaw, err := s.gitOutput("diff", "--name-status", lastCommit+".."+head)
	if err != nil {
		return nil, err
	}
	changedStatusByFile := parseChangedFileStatuses(changedFilesRaw)
	changedFiles := changedStatusByFile.sortedPaths()
	classifications := make(map[string]string, len(changedFiles))
	for _, path := range changedFiles {
		classifications[path] = classifyChange(path, changedStatusByFile[path])
	}
	result.AffectedFiles = changedFiles
	result.Classifications = classifications

	if len(changedFiles) > 0 {
		entries, err := s.store.FindByFilePaths(changedFiles)
		if err != nil {
			return nil, err
		}
		entryClassification := make(map[string]string, len(entries))
		for _, entry := range entries {
			classification := "none"
			for _, path := range entry.FilePaths {
				if next, ok := classifications[path]; ok {
					classification = mergeClassifications(classification, next)
				}
			}
			entryClassification[entry.ID] = classification
		}

		flagged := make(map[string]struct{}, len(entries))
		for _, entry := range entries {
			classification := entryClassification[entry.ID]
			switch classification {
			case "deleted":
				if err := s.store.Supersede(entry.ID, entry.ID); err != nil {
					return nil, err
				}
				result.SupersededCount++
			case "structural":
				if err := s.store.MarkStale(entry.ID); err != nil {
					return nil, err
				}
				result.StaleEntries++
			case "body":
				if err := s.store.DecayEntry(entry.ID, 0.95); err != nil {
					return nil, err
				}
				if err := s.store.UpdateCoveredCommit(entry.ID, head); err != nil {
					return nil, err
				}
			default:
				if err := s.store.UpdateCoveredCommit(entry.ID, head); err != nil {
					return nil, err
				}
			}
			if _, ok := flagged[entry.ID]; !ok {
				flagged[entry.ID] = struct{}{}
				result.FlaggedEntries++
			}
		}

		if hasStructuralClassification(classifications) {
			summaries, listErr := s.store.List(ListOpts{Tag: "project-summary"})
			if listErr == nil {
				for _, summary := range summaries {
					if _, ok := flagged[summary.ID]; ok {
						continue
					}
					if err := s.store.MarkStale(summary.ID); err != nil {
						return nil, err
					}
					flagged[summary.ID] = struct{}{}
					result.StaleEntries++
					result.FlaggedEntries++
				}
			}
		}
	}

	contextUpdated, contextStale := s.tryPatchExploreContext(lastCommit, head, changedFiles)
	result.ContextUpdated = contextUpdated
	result.ContextStale = contextStale

	if err := s.SetLastSyncedCommit(head); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Syncer) Status() (*SyncStatus, error) {
	if s.db == nil {
		return nil, fmt.Errorf("db required")
	}
	if strings.TrimSpace(s.repoDir) == "" {
		return nil, fmt.Errorf("repo dir required")
	}

	last, err := s.GetLastSyncedCommit()
	if err != nil {
		return nil, err
	}
	head, err := s.gitOutput("rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	head = strings.TrimSpace(head)

	status := &SyncStatus{
		LastSyncedCommit: last,
		CurrentCommit:    head,
		SyncNeeded:       false,
		CommitsBehind:    0,
	}

	contextStale, err := s.GetContextStaleFlag()
	if err != nil {
		return nil, err
	}
	status.ContextStale = contextStale

	if strings.TrimSpace(last) == "" {
		status.SyncNeeded = true
		return status, nil
	}
	if last == head {
		return status, nil
	}

	status.SyncNeeded = true
	countRaw, err := s.gitOutput("rev-list", "--count", last+".."+head)
	if err != nil {
		return status, nil
	}
	countRaw = strings.TrimSpace(countRaw)
	if countRaw == "" {
		return status, nil
	}
	count, parseErr := strconv.Atoi(countRaw)
	if parseErr != nil {
		return status, nil
	}
	status.CommitsBehind = count
	return status, nil
}

func (s *Syncer) Refresh(entryID string) (*RefreshResult, error) {
	if s.store == nil {
		return nil, fmt.Errorf("memory store required")
	}
	if strings.TrimSpace(s.repoDir) == "" {
		return nil, fmt.Errorf("repo dir required")
	}

	head, err := s.gitOutput("rev-parse", "HEAD")
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
		entry, err := s.store.Get(result.EntryID)
		if err != nil {
			return nil, err
		}
		if err := s.store.Update(entry.ID, map[string]interface{}{
			"stale":             false,
			"covered_at_commit": head,
		}); err != nil {
			return nil, err
		}
		if entry.Stale {
			result.Updated = 1
		} else {
			result.Skipped = 1
		}
		return result, nil
	}

	entries, err := s.store.FindStaleEntries()
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if err := s.store.Update(entry.ID, map[string]interface{}{
			"stale":             false,
			"covered_at_commit": head,
		}); err != nil {
			return nil, err
		}
		result.Updated++
	}
	return result, nil
}

func (s *Syncer) GetLastSyncedCommit() (string, error) {
	if s.db == nil {
		return "", fmt.Errorf("db required")
	}
	var commit string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key = ?`, metaLastSyncedCommit).Scan(&commit)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get last_synced_commit: %w", err)
	}
	return strings.TrimSpace(commit), nil
}

func (s *Syncer) SetLastSyncedCommit(sha string) error {
	if s.db == nil {
		return fmt.Errorf("db required")
	}
	sha = strings.TrimSpace(sha)
	_, err := s.db.Exec(
		`INSERT INTO meta (key, value)
		 VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		metaLastSyncedCommit,
		sha,
	)
	if err != nil {
		return fmt.Errorf("set last_synced_commit: %w", err)
	}
	return nil
}

func (s *Syncer) GetContextStaleFlag() (bool, error) {
	if s.db == nil {
		return false, fmt.Errorf("db required")
	}
	var raw string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key = ?`, metaExploreContextStale).Scan(&raw)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get explore_context_stale: %w", err)
	}
	raw = strings.TrimSpace(strings.ToLower(raw))
	return raw == "1" || raw == "true" || raw == "yes", nil
}

func (s *Syncer) SetContextStaleFlag(stale bool) error {
	if s.db == nil {
		return fmt.Errorf("db required")
	}
	value := "0"
	if stale {
		value = "1"
	}
	_, err := s.db.Exec(
		`INSERT INTO meta (key, value)
		 VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		metaExploreContextStale,
		value,
	)
	if err != nil {
		return fmt.Errorf("set explore_context_stale: %w", err)
	}
	return nil
}

func (s *Syncer) tryPatchExploreContext(lastCommit, head string, changedFiles []string) (updated bool, stale bool) {
	currentStale, err := s.GetContextStaleFlag()
	if err != nil {
		return false, false
	}
	if !s.canPatchContext() || len(changedFiles) == 0 {
		return false, currentStale
	}
	if !hasCodeChanges(changedFiles) {
		return false, currentStale
	}

	contextText, err := s.loadExploreContext()
	if err != nil {
		return false, currentStale
	}
	if strings.TrimSpace(contextText) == "" {
		return false, currentStale
	}

	diff, err := s.gitOutput("diff", lastCommit+".."+head)
	if err != nil {
		_ = s.SetContextStaleFlag(true)
		return false, true
	}
	diff = strings.TrimSpace(diff)
	if diff == "" {
		return false, currentStale
	}
	if s.maxDiffBytes > 0 && len(diff) > s.maxDiffBytes {
		_ = s.SetContextStaleFlag(true)
		return false, true
	}

	adapter := worker.NewAdapter(s.driver, s.model, s.timeout)
	prompt := fmt.Sprintf(prompts.SyncContext, contextText, diff, strings.Join(changedFiles, "\n"))
	runResult, runErr := adapter.Execute(context.Background(), "sync_context", prompt, s.repoDir)
	if runErr != nil || runResult == nil || runResult.ExitCode != 0 {
		_ = s.SetContextStaleFlag(true)
		return false, true
	}

	patched := strings.TrimSpace(runResult.Stdout)
	if patched == "" {
		_ = s.SetContextStaleFlag(true)
		return false, true
	}
	if err := s.writeExploreContext(patched); err != nil {
		_ = s.SetContextStaleFlag(true)
		return false, true
	}

	_ = s.SetContextStaleFlag(false)
	return true, false
}

func (s *Syncer) canPatchContext() bool {
	return s.driver != nil && s.toolName != ""
}

func (s *Syncer) loadExploreContext() (string, error) {
	if s.db == nil {
		return "", fmt.Errorf("db required")
	}
	var content string
	err := s.db.QueryRow(`SELECT content FROM explore_context WHERE id = ?`, exploreContextRowID).Scan(&content)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(content), nil
}

func (s *Syncer) writeExploreContext(content string) error {
	hash, err := s.hashFileTree()
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`REPLACE INTO explore_context (id, content, hash, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
		exploreContextRowID,
		content,
		hash,
	)
	if err != nil {
		return fmt.Errorf("write explore_context: %w", err)
	}
	return nil
}

func (s *Syncer) hashFileTree() (string, error) {
	out, err := s.gitOutput("ls-files")
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(out))
	return hex.EncodeToString(sum[:]), nil
}

func (s *Syncer) gitOutput(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = s.repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

type changedFileStatuses map[string]string

func (m changedFileStatuses) sortedPaths() []string {
	paths := make([]string, 0, len(m))
	for path := range m {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func parseChangedFileStatuses(raw string) changedFileStatuses {
	statuses := make(changedFileStatuses)
	lines := strings.Split(raw, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 2 {
			continue
		}
		code := strings.ToUpper(strings.TrimSpace(parts[0]))
		switch {
		case strings.HasPrefix(code, "R"), strings.HasPrefix(code, "C"):
			if len(parts) >= 3 {
				oldPath := normalizeSinglePath(parts[1])
				newPath := normalizeSinglePath(parts[2])
				if oldPath != "" {
					statuses[oldPath] = mergeFileStatus(statuses[oldPath], "deleted")
				}
				if newPath != "" {
					statuses[newPath] = mergeFileStatus(statuses[newPath], "modified")
				}
			}
		default:
			path := normalizeSinglePath(parts[len(parts)-1])
			if path == "" {
				continue
			}
			fileStatus := "modified"
			if strings.HasPrefix(code, "D") {
				fileStatus = "deleted"
			}
			statuses[path] = mergeFileStatus(statuses[path], fileStatus)
		}
	}
	return statuses
}

func normalizeSinglePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	return filepath.ToSlash(path)
}

func mergeFileStatus(current, next string) string {
	if statusPriority(next) > statusPriority(current) {
		return next
	}
	return current
}

func statusPriority(status string) int {
	switch status {
	case "deleted":
		return 2
	case "modified":
		return 1
	default:
		return 0
	}
}

func classifyChange(path, fileStatus string) string {
	if strings.TrimSpace(fileStatus) == "deleted" {
		return "deleted"
	}
	if !isCodeOrStructuralPath(path) {
		return "none"
	}
	if isStructuralFile(path) {
		return "structural"
	}
	return "body"
}

func mergeClassifications(current, next string) string {
	if classificationPriority(next) > classificationPriority(current) {
		return next
	}
	return current
}

func classificationPriority(classification string) int {
	switch classification {
	case "deleted":
		return 4
	case "structural":
		return 3
	case "body":
		return 2
	case "none":
		return 1
	default:
		return 0
	}
}

func hasStructuralClassification(classifications map[string]string) bool {
	for _, c := range classifications {
		if c == "structural" || c == "deleted" {
			return true
		}
	}
	return false
}

func normalizeChangedFilePaths(paths []string) []string {
	if len(paths) == 0 {
		return []string{}
	}
	seen := make(map[string]struct{}, len(paths))
	normalized := make([]string, 0, len(paths))
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		path = filepath.ToSlash(path)
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		normalized = append(normalized, path)
	}
	sort.Strings(normalized)
	return normalized
}

func hasCodeChanges(paths []string) bool {
	for _, path := range paths {
		if isCodeOrStructuralPath(path) {
			return true
		}
	}
	return false
}

func isCodeOrStructuralPath(path string) bool {
	path = strings.TrimSpace(filepath.ToSlash(path))
	if path == "" {
		return false
	}
	if strings.HasPrefix(path, ".orca/") || path == ".orca" {
		return false
	}
	if isStructuralFile(path) {
		return true
	}
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".rb", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift", ".kt", ".kts", ".php", ".sh", ".bash", ".zsh", ".sql", ".proto", ".graphql", ".vue", ".svelte":
		return true
	default:
		return false
	}
}

func isStructuralFile(path string) bool {
	base := filepath.Base(path)
	_, ok := syncStructuralFiles[base]
	return ok
}
