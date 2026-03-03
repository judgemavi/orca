// sync.go contains deterministic git-diff sync and stale-marking behavior.
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

	"github.com/jasjeetmavi/orca/internal/diffclass"
	"github.com/jasjeetmavi/orca/internal/toolcfg"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

const (
	metaLastSyncedCommit    = "last_synced_commit"
	metaExploreContextStale = "explore_context_stale"
	exploreContextRowID     = 1
)

var syncProjectSummaryFiles = map[string]struct{}{
	"go.mod":              {},
	"go.sum":              {},
	"package.json":        {},
	"package-lock.json":   {},
	"pnpm-lock.yaml":      {},
	"yarn.lock":           {},
	"bun.lock":            {},
	"bun.lockb":           {},
	"Cargo.toml":          {},
	"Cargo.lock":          {},
	"pyproject.toml":      {},
	"requirements.txt":    {},
	"Makefile":            {},
	"Dockerfile":          {},
	"docker-compose.yml":  {},
	"docker-compose.yaml": {},
	"Taskfile.yml":        {},
}

type Syncer struct {
	store   *Store
	db      *sql.DB
	repoDir string

	toolName string
	tool     toolcfg.Tool
	model    string
	timeout  time.Duration

	maxDiffBytes int

	diffConfig        diffclass.Config
	minorDecayFactor  float64
	mediumDecayFactor float64
	majorDecayFactor  float64
}

type SyncResult struct {
	LastCommit      string                          `json:"last_commit"`
	NewCommit       string                          `json:"new_commit"`
	CommitCount     int                             `json:"commit_count"`
	AffectedFiles   []string                        `json:"affected_files"`
	FlaggedEntries  int                             `json:"flagged_entries"`
	StaleEntries    int                             `json:"stale_entries"`
	SupersededCount int                             `json:"superseded_count"`
	Classifications map[string]diffclass.ChangeType `json:"classifications"`
	ContextUpdated  bool                            `json:"context_updated"`
	ContextStale    bool                            `json:"context_stale"`
}

type SyncStatus struct {
	LastSyncedCommit string `json:"last_synced_commit"`
	CurrentCommit    string `json:"current_commit"`
	SyncNeeded       bool   `json:"sync_needed"`
	CommitsBehind    int    `json:"commits_behind"`
	ContextStale     bool   `json:"context_stale"`
}

func NewSyncer(store *Store, db *sql.DB, repoDir, toolName string, tool toolcfg.Tool, model string, timeout time.Duration) *Syncer {
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	return &Syncer{
		store:             store,
		db:                db,
		repoDir:           repoDir,
		toolName:          strings.TrimSpace(toolName),
		tool:              tool,
		model:             strings.TrimSpace(model),
		timeout:           timeout,
		maxDiffBytes:      200_000,
		diffConfig:        diffclass.DefaultConfig(),
		minorDecayFactor:  0.95,
		mediumDecayFactor: 0.85,
		majorDecayFactor:  0.70,
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
		Classifications: map[string]diffclass.ChangeType{},
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

	commitsRaw, err := s.gitOutput("rev-list", "--reverse", lastCommit+".."+head)
	if err != nil {
		return nil, err
	}
	commits := splitNonEmptyLines(commitsRaw)
	result.CommitCount = len(commits)
	if len(commits) == 0 {
		result.ContextStale, _ = s.GetContextStaleFlag()
		if err := s.SetLastSyncedCommit(head); err != nil {
			return nil, err
		}
		return result, nil
	}

	stats, err := diffclass.DiffStatsBetween(s.repoDir, lastCommit, head)
	if err != nil {
		return nil, err
	}

	classifications := make(map[string]diffclass.ChangeType)
	changedPaths := make([]string, 0, len(stats)*2)
	affected := make(map[string]struct{})
	flagged := make(map[string]struct{})
	staleMarked := make(map[string]struct{})
	superseded := make(map[string]struct{})
	majorConfigChanged := false

	for _, stat := range stats {
		changeType := diffclass.ClassifyDiffWithConfig(stat, s.diffConfig)
		if changeType == diffclass.ChangeNone {
			continue
		}

		keyPath := strings.TrimSpace(stat.FilePath)
		if keyPath == "" {
			keyPath = strings.TrimSpace(stat.NewPath)
		}
		if keyPath != "" {
			classifications[keyPath] = mergeClassifications(classifications[keyPath], changeType)
		}
		if stat.FilePath != "" {
			changedPaths = append(changedPaths, stat.FilePath)
			affected[stat.FilePath] = struct{}{}
		}
		if stat.NewPath != "" {
			affected[stat.NewPath] = struct{}{}
		}
		if changeType == diffclass.ChangeMajor && isProjectSummarySignal(stat.FilePath) {
			majorConfigChanged = true
		}
	}

	changedPaths = normalizeChangedFilePaths(changedPaths)
	entries, err := s.store.FindByFilePaths(changedPaths)
	if err != nil {
		return nil, err
	}

	entryClasses := make(map[string]diffclass.ChangeType, len(entries))
	for _, entry := range entries {
		entryClass := diffclass.ChangeNone
		for _, path := range entry.FilePaths {
			if next, ok := classifications[path]; ok {
				entryClass = mergeClassifications(entryClass, next)
			}
		}
		if entryClass != diffclass.ChangeNone {
			entryClasses[entry.ID] = entryClass
		}
	}

	for _, stat := range stats {
		if diffclass.ClassifyDiffWithConfig(stat, s.diffConfig) != diffclass.ChangeRenamed {
			continue
		}
		if _, err := s.store.RenameFilePathAssociations(stat.FilePath, stat.NewPath); err != nil {
			return nil, err
		}
	}

	for _, entry := range entries {
		entryClass := entryClasses[entry.ID]
		if entryClass == diffclass.ChangeNone {
			continue
		}
		if err := s.applyEntryClassification(entry, entryClass, head); err != nil {
			return nil, err
		}
		flagged[entry.ID] = struct{}{}
		if entryClass == diffclass.ChangeMajor {
			staleMarked[entry.ID] = struct{}{}
		}
		if entryClass == diffclass.ChangeDeleted {
			superseded[entry.ID] = struct{}{}
		}
	}

	result.AffectedFiles = mapKeysSorted(affected)
	result.Classifications = classifications
	result.FlaggedEntries = len(flagged)
	result.StaleEntries = len(staleMarked)
	result.SupersededCount = len(superseded)

	if majorConfigChanged {
		summaries, listErr := s.store.List(ListOpts{Tag: "project-summary"})
		if listErr == nil {
			for _, summary := range summaries {
				if _, already := staleMarked[summary.ID]; already {
					continue
				}
				if err := s.store.MarkStale(summary.ID); err != nil {
					return nil, err
				}
				staleMarked[summary.ID] = struct{}{}
				flagged[summary.ID] = struct{}{}
			}
		}
	}
	result.FlaggedEntries = len(flagged)
	result.StaleEntries = len(staleMarked)

	changedFiles := result.AffectedFiles
	contextUpdated, contextStale := s.tryPatchExploreContext(lastCommit, head, changedFiles)
	result.ContextUpdated = contextUpdated
	result.ContextStale = contextStale

	if err := s.SetLastSyncedCommit(head); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Syncer) applyEntryClassification(entry *Entry, classification diffclass.ChangeType, commit string) error {
	if entry == nil {
		return nil
	}
	switch classification {
	case diffclass.ChangeDeleted:
		return s.store.Supersede(entry.ID, entry.ID)
	case diffclass.ChangeMinor:
		if err := s.store.DecayEntry(entry.ID, s.minorDecayFactor); err != nil {
			return err
		}
		return s.store.UpdateCoveredCommit(entry.ID, commit)
	case diffclass.ChangeMedium:
		if err := s.store.DecayEntry(entry.ID, s.mediumDecayFactor); err != nil {
			return err
		}
		return s.store.UpdateCoveredCommit(entry.ID, commit)
	case diffclass.ChangeMajor:
		if err := s.store.DecayEntry(entry.ID, s.majorDecayFactor); err != nil {
			return err
		}
		if err := s.store.MarkStale(entry.ID); err != nil {
			return err
		}
		return s.store.UpdateCoveredCommit(entry.ID, commit)
	case diffclass.ChangeRenamed:
		return s.store.UpdateCoveredCommit(entry.ID, commit)
	default:
		return s.store.UpdateCoveredCommit(entry.ID, commit)
	}
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

	adapter := worker.NewAdapter(s.toolName, s.tool, s.model, s.timeout)
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
	return strings.TrimSpace(s.tool.Binary) != "" && strings.TrimSpace(s.toolName) != ""
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

func splitNonEmptyLines(raw string) []string {
	lines := strings.Split(raw, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}

func mapKeysSorted(values map[string]struct{}) []string {
	if len(values) == 0 {
		return []string{}
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func emptyIfBlank(value string) string {
	if strings.TrimSpace(value) == "" {
		return "(none)"
	}
	return strings.TrimSpace(value)
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

func mergeClassifications(current, next diffclass.ChangeType) diffclass.ChangeType {
	if classificationPriority(next) > classificationPriority(current) {
		return next
	}
	return current
}

func classificationPriority(classification diffclass.ChangeType) int {
	switch classification {
	case diffclass.ChangeDeleted:
		return 6
	case diffclass.ChangeMajor:
		return 5
	case diffclass.ChangeRenamed:
		return 4
	case diffclass.ChangeMedium:
		return 3
	case diffclass.ChangeMinor:
		return 2
	case diffclass.ChangeNone:
		return 1
	default:
		return 0
	}
}

func isProjectSummarySignal(path string) bool {
	path = strings.TrimSpace(filepath.ToSlash(path))
	if path == "" || strings.Contains(path, "/") {
		return false
	}
	_, ok := syncProjectSummaryFiles[path]
	return ok
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
	if isProjectSummarySignal(path) {
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
