package memory

import (
	"database/sql"
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

type Syncer struct {
	store   *Store
	db      *sql.DB
	repoDir string
}

type SyncResult struct {
	LastCommit     string   `json:"last_commit"`
	NewCommit      string   `json:"new_commit"`
	CommitCount    int      `json:"commit_count"`
	AffectedFiles  []string `json:"affected_files"`
	FlaggedEntries int      `json:"flagged_entries"`
}

func NewSyncer(store *Store, db *sql.DB, repoDir string) *Syncer {
	return &Syncer{store: store, db: db, repoDir: repoDir}
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
		LastCommit:     lastCommit,
		NewCommit:      head,
		CommitCount:    0,
		AffectedFiles:  []string{},
		FlaggedEntries: 0,
	}

	if strings.TrimSpace(lastCommit) == "" {
		if err := s.SetLastSyncedCommit(head); err != nil {
			return nil, err
		}
		return result, nil
	}
	if lastCommit == head {
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

	changedFilesRaw, err := s.gitOutput("diff", "--name-only", lastCommit+".."+head)
	if err != nil {
		return nil, err
	}
	changedFiles := normalizeChangedFilePaths(strings.Split(changedFilesRaw, "\n"))
	result.AffectedFiles = changedFiles

	if len(changedFiles) > 0 {
		entries, err := s.store.FindByFilePaths(changedFiles)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			sourceType := strings.TrimSpace(strings.ToLower(entry.SourceType))
			if sourceType == "" {
				sourceType = "retro"
			}
			switch sourceType {
			case "task":
				if err := s.store.DecayEntry(entry.ID, 0.9); err != nil {
					return nil, err
				}
			case "commit":
				if err := s.store.Supersede(entry.ID, entry.ID); err != nil {
					return nil, err
				}
			default:
				if err := s.store.DecayEntry(entry.ID, 0.8); err != nil {
					return nil, err
				}
			}
			result.FlaggedEntries++
		}
	}

	if err := s.SetLastSyncedCommit(head); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Syncer) GetLastSyncedCommit() (string, error) {
	if s.db == nil {
		return "", fmt.Errorf("db required")
	}
	var commit string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key = 'last_synced_commit'`).Scan(&commit)
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
		 VALUES ('last_synced_commit', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		sha,
	)
	if err != nil {
		return fmt.Errorf("set last_synced_commit: %w", err)
	}
	return nil
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
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		normalized = append(normalized, path)
	}
	sort.Strings(normalized)
	return normalized
}
