// store.go holds low-level SQLite-backed storage, indexing, and lineage helpers.
package memory

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/state"
)

const entryColumns = `
	id, content, category, tags, source_task_id, source_interaction_id,
	confidence, provenance_hash, superseded_by, source_type, covered_at_commit, stale, created_at, updated_at
`

const entryColumnsQualified = `
	ke.id, ke.content, ke.category, ke.tags, ke.source_task_id, ke.source_interaction_id,
	ke.confidence, ke.provenance_hash, ke.superseded_by, ke.source_type, ke.covered_at_commit, ke.stale, ke.created_at, ke.updated_at
`

// Entry is a single memory row persisted in SQLite.
type Entry struct {
	ID                  string    `json:"id"`
	Content             string    `json:"content"`
	Category            string    `json:"category"`
	Tags                []string  `json:"tags"`
	SourceTaskID        string    `json:"source_task_id,omitempty"`
	SourceInteractionID string    `json:"source_interaction_id,omitempty"`
	SourceType          string    `json:"source_type"`
	FilePaths           []string  `json:"file_paths,omitempty"`
	CoveredAtCommit     string    `json:"covered_at_commit"`
	Stale               bool      `json:"stale"`
	Confidence          float64   `json:"confidence"`
	ProvenanceHash      string    `json:"provenance_hash"`
	SupersededBy        string    `json:"superseded_by,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

// UsedByTask captures task lineage for memory consumption.
type UsedByTask struct {
	TaskID string `json:"task_id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// HealthSummary provides aggregate memory health data.
type HealthSummary struct {
	TotalEntries   int            `json:"total_entries"`
	BySource       map[string]int `json:"by_source"`
	StaleCount     int            `json:"stale_count"`
	AverageQuality float64        `json:"avg_confidence"`
}

// ListOpts controls list filtering.
type ListOpts struct {
	Category      string
	Tag           string
	SourceType    string
	FilePath      string
	StaleOnly     bool
	CoveredBefore string
}

type UpdateFields struct {
	Content         *string
	Category        *string
	Confidence      *float64
	SourceType      *string
	Stale           *bool
	CoveredAtCommit *string
	Tags            []string // nil = no change, empty = clear
}

func Ptr[T any](value T) *T {
	return &value
}

// Store persists memory entries and mirrors data into the FTS table.
type Store struct {
	db *state.DB
}

func NewStore(db *state.DB) *Store {
	return &Store{db: db}
}

func (s *Store) Create(e *Entry) error {
	if e == nil {
		return fmt.Errorf("entry required")
	}
	if strings.TrimSpace(e.Content) == "" {
		return fmt.Errorf("content required")
	}
	if strings.TrimSpace(e.Category) == "" {
		return fmt.Errorf("category required")
	}
	if strings.TrimSpace(e.ProvenanceHash) == "" {
		return fmt.Errorf("provenance hash required")
	}

	tagsJSON, err := marshalTags(e.Tags)
	if err != nil {
		return fmt.Errorf("marshal tags: %w", err)
	}

	id := uuid.New().String()
	now := time.Now().UTC()
	confidence := e.Confidence
	if confidence == 0 {
		confidence = 1.0
	}
	sourceType, err := normalizeSourceType(e.SourceType)
	if err != nil {
		return err
	}
	filePaths := normalizeFilePaths(e.FilePaths)
	coveredAtCommit := strings.TrimSpace(e.CoveredAtCommit)

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin create memory entry: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT INTO memory_entries (
				id, content, category, tags, source_task_id, source_interaction_id,
				confidence, provenance_hash, superseded_by, source_type, covered_at_commit, stale, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		id,
		e.Content,
		e.Category,
		tagsJSON,
		nullableString(e.SourceTaskID),
		nullableString(e.SourceInteractionID),
		confidence,
		e.ProvenanceHash,
		nullableString(e.SupersededBy),
		sourceType,
		coveredAtCommit,
		now,
		now,
	); err != nil {
		return fmt.Errorf("insert memory entry: %w", err)
	}

	if err := upsertFTS(tx, id, e.Content, tagsJSON); err != nil {
		return err
	}
	if len(filePaths) > 0 {
		if err := s.associateFilesTx(tx, id, filePaths); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit create memory entry: %w", err)
	}

	e.ID = id
	e.Confidence = confidence
	e.SourceType = sourceType
	e.FilePaths = filePaths
	e.CoveredAtCommit = coveredAtCommit
	e.Stale = false
	e.CreatedAt = now
	e.UpdatedAt = now
	return nil
}

func (s *Store) Get(id string) (*Entry, error) {
	row := s.db.QueryRow(
		fmt.Sprintf(`SELECT %s FROM memory_entries WHERE id = ?`, entryColumns),
		id,
	)
	entry, err := scanEntry(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("memory entry %s not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get memory entry: %w", err)
	}
	entry.FilePaths, err = s.GetFilePaths(entry.ID)
	if err != nil {
		return nil, err
	}
	return entry, nil
}

func (s *Store) GetByProvenanceHash(hash string) (*Entry, error) {
	hash = strings.TrimSpace(hash)
	if hash == "" {
		return nil, nil
	}

	row := s.db.QueryRow(
		fmt.Sprintf(
			`SELECT %s FROM memory_entries WHERE provenance_hash = ? ORDER BY created_at DESC LIMIT 1`,
			entryColumns,
		),
		hash,
	)
	entry, err := scanEntry(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get memory entry by provenance hash: %w", err)
	}
	entry.FilePaths, err = s.GetFilePaths(entry.ID)
	if err != nil {
		return nil, err
	}
	return entry, nil
}

func (s *Store) HasProvenanceHash(hash string) (bool, error) {
	entry, err := s.GetByProvenanceHash(hash)
	if err != nil {
		return false, err
	}
	return entry != nil, nil
}

func (s *Store) List(opts ListOpts) ([]*Entry, error) {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(`SELECT %s FROM memory_entries WHERE superseded_by IS NULL`, entryColumns))
	args := make([]interface{}, 0, 4)

	if strings.TrimSpace(opts.Category) != "" {
		sb.WriteString(` AND category = ?`)
		args = append(args, opts.Category)
	}
	if strings.TrimSpace(opts.Tag) != "" {
		sb.WriteString(` AND tags LIKE ?`)
		args = append(args, fmt.Sprintf("%%\"%s\"%%", opts.Tag))
	}
	if strings.TrimSpace(opts.SourceType) != "" {
		sourceType, err := normalizeSourceType(opts.SourceType)
		if err != nil {
			return nil, err
		}
		sb.WriteString(` AND source_type = ?`)
		args = append(args, sourceType)
	}
	if filePath := strings.TrimSpace(opts.FilePath); filePath != "" {
		sb.WriteString(` AND EXISTS (
			SELECT 1 FROM memory_file_associations mfa
			WHERE mfa.memory_id = memory_entries.id AND mfa.file_path = ?
		)`)
		args = append(args, filePath)
	}
	if opts.StaleOnly {
		sb.WriteString(` AND stale = 1`)
	}
	if coveredBefore := strings.TrimSpace(opts.CoveredBefore); coveredBefore != "" {
		sb.WriteString(` AND (covered_at_commit = '' OR covered_at_commit <> ?)`)
		args = append(args, coveredBefore)
	}
	sb.WriteString(` ORDER BY created_at`)

	rows, err := s.db.Query(sb.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list memory entries: %w", err)
	}
	defer rows.Close()
	entries, err := scanEntries(rows)
	if err != nil {
		return nil, err
	}
	if err := s.loadFilePaths(entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func (s *Store) Update(id string, fields UpdateFields) error {
	if fields.Content == nil &&
		fields.Category == nil &&
		fields.Confidence == nil &&
		fields.SourceType == nil &&
		fields.Stale == nil &&
		fields.CoveredAtCommit == nil &&
		fields.Tags == nil {
		return nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin update memory entry: %w", err)
	}
	defer tx.Rollback()

	setClauses := make([]string, 0, 8)
	args := make([]interface{}, 0, 10)
	if fields.Content != nil {
		setClauses = append(setClauses, "content = ?")
		args = append(args, *fields.Content)
	}
	if fields.Category != nil {
		setClauses = append(setClauses, "category = ?")
		args = append(args, *fields.Category)
	}
	if fields.Confidence != nil {
		setClauses = append(setClauses, "confidence = ?")
		args = append(args, *fields.Confidence)
	}
	if fields.SourceType != nil {
		sourceType, err := normalizeSourceType(*fields.SourceType)
		if err != nil {
			return err
		}
		setClauses = append(setClauses, "source_type = ?")
		args = append(args, sourceType)
	}
	if fields.Stale != nil {
		stale := 0
		if *fields.Stale {
			stale = 1
		}
		setClauses = append(setClauses, "stale = ?")
		args = append(args, stale)
	}
	if fields.CoveredAtCommit != nil {
		setClauses = append(setClauses, "covered_at_commit = ?")
		args = append(args, strings.TrimSpace(*fields.CoveredAtCommit))
	}
	if fields.Tags != nil {
		tagsJSON, err := marshalTags(fields.Tags)
		if err != nil {
			return fmt.Errorf("marshal tags: %w", err)
		}
		setClauses = append(setClauses, "tags = ?")
		args = append(args, tagsJSON)
	}
	setClauses = append(setClauses, "updated_at = ?")
	args = append(args, time.Now().UTC(), id)

	query := fmt.Sprintf("UPDATE memory_entries SET %s WHERE id = ?", strings.Join(setClauses, ", "))
	res, err := tx.Exec(query, args...)
	if err != nil {
		return fmt.Errorf("update memory entry: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("update memory entry rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("memory entry %s not found", id)
	}

	var content, tagsJSON string
	if err := tx.QueryRow(
		`SELECT content, tags FROM memory_entries WHERE id = ?`,
		id,
	).Scan(&content, &tagsJSON); err != nil {
		return fmt.Errorf("load updated memory entry for fts: %w", err)
	}

	if err := upsertFTS(tx, id, content, tagsJSON); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit update memory entry: %w", err)
	}
	return nil
}

func (s *Store) Delete(id string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin delete memory entry: %w", err)
	}
	defer tx.Rollback()

	res, err := tx.Exec(`DELETE FROM memory_entries WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete memory entry: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete memory entry rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("memory entry %s not found", id)
	}

	if _, err := tx.Exec(`DELETE FROM memory_fts WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete memory fts row: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete memory entry: %w", err)
	}
	return nil
}

func (s *Store) Search(query string, limit int) ([]*Entry, error) {
	return s.search(query, limit, nil)
}

func (s *Store) SearchExcluding(query string, limit int, excludeHashes []string) ([]*Entry, error) {
	return s.search(query, limit, excludeHashes)
}

func (s *Store) search(query string, limit int, excludeHashes []string) ([]*Entry, error) {
	if strings.TrimSpace(query) == "" || limit <= 0 {
		return []*Entry{}, nil
	}

	ftsQuery := buildFTSQuery(query)
	if ftsQuery == "" {
		return []*Entry{}, nil
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(
		`SELECT %s FROM memory_entries ke
		 JOIN memory_fts ON ke.id = memory_fts.id
		 WHERE memory_fts MATCH ?
		 AND ke.superseded_by IS NULL
		 AND ke.confidence >= 0.3`,
		entryColumnsQualified,
	))
	args := make([]interface{}, 0, len(excludeHashes)+2)
	args = append(args, ftsQuery)

	if len(excludeHashes) > 0 {
		sb.WriteString(" AND ke.provenance_hash NOT IN (")
		sb.WriteString(strings.TrimSuffix(strings.Repeat("?,", len(excludeHashes)), ","))
		sb.WriteString(")")
		for _, hash := range excludeHashes {
			args = append(args, hash)
		}
	}

	sb.WriteString(` ORDER BY bm25(memory_fts) LIMIT ?`)
	args = append(args, limit)

	rows, err := s.db.Query(sb.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("search memory entries: %w", err)
	}
	defer rows.Close()
	entries, err := scanEntries(rows)
	if err != nil {
		return nil, err
	}
	if err := s.loadFilePaths(entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func (s *Store) Supersede(oldID, newID string) error {
	res, err := s.db.Exec(
		`UPDATE memory_entries
		 SET superseded_by = ?, updated_at = ?
		 WHERE id = ?`,
		newID,
		time.Now().UTC(),
		oldID,
	)
	if err != nil {
		return fmt.Errorf("supersede memory entry: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("supersede memory entry rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("memory entry %s not found", oldID)
	}
	return nil
}

func (s *Store) DecayConfidence(olderThan time.Duration, factor float64) (int, error) {
	if olderThan <= 0 {
		return 0, fmt.Errorf("olderThan must be > 0")
	}
	if factor <= 0 {
		return 0, fmt.Errorf("factor must be > 0")
	}

	cutoff := time.Now().UTC().Add(-olderThan)
	res, err := s.db.Exec(`
		UPDATE memory_entries
		SET confidence = confidence * ?,
		    updated_at = CURRENT_TIMESTAMP
		WHERE updated_at < ?
		AND superseded_by IS NULL
		AND confidence > 0.1
		AND id NOT IN (
			SELECT DISTINCT json_each.value
			FROM task_interactions, json_each(json_extract(quality_json, '$.used_memory_ids'))
			WHERE task_interactions.status = 'completed'
			AND task_interactions.finished_at >= ?
		)
	`, factor, cutoff, cutoff)
	if err != nil {
		return 0, fmt.Errorf("decay confidence: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("decay confidence rows affected: %w", err)
	}
	return int(affected), nil
}

func (s *Store) AssociateFiles(entryID string, paths []string) error {
	entryID = strings.TrimSpace(entryID)
	if entryID == "" {
		return fmt.Errorf("entry id required")
	}
	filePaths := normalizeFilePaths(paths)
	if len(filePaths) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin associate files: %w", err)
	}
	defer tx.Rollback()
	if err := s.associateFilesTx(tx, entryID, filePaths); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit associate files: %w", err)
	}
	return nil
}

func (s *Store) GetFilePaths(entryID string) ([]string, error) {
	entryID = strings.TrimSpace(entryID)
	if entryID == "" {
		return []string{}, nil
	}
	rows, err := s.db.Query(
		`SELECT file_path FROM memory_file_associations WHERE memory_id = ? ORDER BY file_path`,
		entryID,
	)
	if err != nil {
		return nil, fmt.Errorf("get memory file paths: %w", err)
	}
	defer rows.Close()
	paths := make([]string, 0)
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return paths, nil
}

func (s *Store) RenameFilePathAssociations(oldPath, newPath string) (int, error) {
	oldPath = strings.TrimSpace(oldPath)
	newPath = strings.TrimSpace(newPath)
	if oldPath == "" || newPath == "" || oldPath == newPath {
		return 0, nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin rename file path associations: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT OR IGNORE INTO memory_file_associations (memory_id, file_path)
		 SELECT memory_id, ?
		 FROM memory_file_associations
		 WHERE file_path = ?`,
		newPath,
		oldPath,
	); err != nil {
		return 0, fmt.Errorf("insert renamed file path associations: %w", err)
	}

	res, err := tx.Exec(
		`DELETE FROM memory_file_associations WHERE file_path = ?`,
		oldPath,
	)
	if err != nil {
		return 0, fmt.Errorf("delete old file path associations: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("delete old file path associations rows affected: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit rename file path associations: %w", err)
	}
	return int(affected), nil
}

func (s *Store) FindByFilePaths(paths []string) ([]*Entry, error) {
	filePaths := normalizeFilePaths(paths)
	if len(filePaths) == 0 {
		return []*Entry{}, nil
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(
		`SELECT DISTINCT %s FROM memory_entries ke
		JOIN memory_file_associations mfa ON mfa.memory_id = ke.id
		WHERE ke.superseded_by IS NULL
		AND mfa.file_path IN (`,
		entryColumnsQualified,
	))
	sb.WriteString(strings.TrimSuffix(strings.Repeat("?,", len(filePaths)), ","))
	sb.WriteString(`) ORDER BY ke.created_at`)

	args := make([]interface{}, 0, len(filePaths))
	for _, path := range filePaths {
		args = append(args, path)
	}
	rows, err := s.db.Query(sb.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("find memory by file paths: %w", err)
	}
	defer rows.Close()
	entries, err := scanEntries(rows)
	if err != nil {
		return nil, err
	}
	if err := s.loadFilePaths(entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func (s *Store) BoostConfidence(id string, factor float64) error {
	if factor <= 0 {
		return fmt.Errorf("factor must be > 0")
	}
	res, err := s.db.Exec(
		`UPDATE memory_entries
		 SET confidence = MIN(1.0, confidence * ?),
		     updated_at = CURRENT_TIMESTAMP
		 WHERE id = ?`,
		factor,
		id,
	)
	if err != nil {
		return fmt.Errorf("boost confidence: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("boost confidence rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("memory entry %s not found", id)
	}
	return nil
}

func (s *Store) DecayEntry(id string, factor float64) error {
	if factor <= 0 {
		return fmt.Errorf("factor must be > 0")
	}
	res, err := s.db.Exec(
		`UPDATE memory_entries
		 SET confidence = MAX(0.1, confidence * ?),
		     updated_at = CURRENT_TIMESTAMP
		 WHERE id = ?`,
		factor,
		id,
	)
	if err != nil {
		return fmt.Errorf("decay memory entry: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("decay memory entry rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("memory entry %s not found", id)
	}
	return nil
}

func (s *Store) MarkStale(id string) error {
	res, err := s.db.Exec(
		`UPDATE memory_entries
		 SET stale = 1,
		     updated_at = CURRENT_TIMESTAMP
		 WHERE id = ?`,
		id,
	)
	if err != nil {
		return fmt.Errorf("mark stale memory entry: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("mark stale memory entry rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("memory entry %s not found", id)
	}
	return nil
}

func (s *Store) UpdateCoveredCommit(id string, commitSHA string) error {
	commitSHA = strings.TrimSpace(commitSHA)
	res, err := s.db.Exec(
		`UPDATE memory_entries
		 SET covered_at_commit = ?,
		     updated_at = CURRENT_TIMESTAMP
		 WHERE id = ?`,
		commitSHA,
		id,
	)
	if err != nil {
		return fmt.Errorf("update covered_at_commit: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("update covered_at_commit rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("memory entry %s not found", id)
	}
	return nil
}

func (s *Store) FindStaleEntries() ([]*Entry, error) {
	rows, err := s.db.Query(
		fmt.Sprintf(
			`SELECT %s
			 FROM memory_entries
			 WHERE superseded_by IS NULL
			   AND stale = 1
			 ORDER BY updated_at`,
			entryColumns,
		),
	)
	if err != nil {
		return nil, fmt.Errorf("find stale memory entries: %w", err)
	}
	defer rows.Close()
	entries, err := scanEntries(rows)
	if err != nil {
		return nil, err
	}
	if err := s.loadFilePaths(entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func (s *Store) FindUsedByTasks(entryID string) ([]UsedByTask, error) {
	entryID = strings.TrimSpace(entryID)
	if entryID == "" {
		return []UsedByTask{}, nil
	}
	rows, err := s.db.Query(
		`SELECT DISTINCT t.id, t.title, t.status
		 FROM task_interactions ti
		 JOIN tasks t ON t.id = ti.task_id
		 JOIN json_each(
			CASE
				WHEN json_valid(ti.quality_json)
				THEN COALESCE(json_extract(ti.quality_json, '$.used_memory_ids'), '[]')
				ELSE '[]'
			END
		 ) used
		 WHERE ti.task_id IS NOT NULL
		   AND used.value = ?
		 ORDER BY t.updated_at DESC`,
		entryID,
	)
	if err != nil {
		return nil, fmt.Errorf("find used-by tasks: %w", err)
	}
	defer rows.Close()
	usedBy := make([]UsedByTask, 0)
	for rows.Next() {
		var info UsedByTask
		if err := rows.Scan(&info.TaskID, &info.Title, &info.Status); err != nil {
			return nil, err
		}
		usedBy = append(usedBy, info)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return usedBy, nil
}

func (s *Store) FindSupersededIDs(entryID string) ([]string, error) {
	entryID = strings.TrimSpace(entryID)
	if entryID == "" {
		return []string{}, nil
	}
	rows, err := s.db.Query(
		`SELECT id
		 FROM memory_entries
		 WHERE superseded_by = ?
		 ORDER BY created_at`,
		entryID,
	)
	if err != nil {
		return nil, fmt.Errorf("find superseded ids: %w", err)
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func (s *Store) BuildHealthSummary() (*HealthSummary, error) {
	summary := &HealthSummary{
		BySource: make(map[string]int),
	}

	rows, err := s.db.Query(
		`SELECT source_type, COUNT(*)
		 FROM memory_entries
		 WHERE superseded_by IS NULL
		 GROUP BY source_type`,
	)
	if err != nil {
		return nil, fmt.Errorf("memory health by source: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var sourceType string
		var count int
		if err := rows.Scan(&sourceType, &count); err != nil {
			return nil, err
		}
		summary.BySource[sourceType] = count
		summary.TotalEntries += count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if err := s.db.QueryRow(
		`SELECT COUNT(*)
		 FROM memory_entries
		 WHERE superseded_by IS NULL
		   AND stale = 1`,
	).Scan(&summary.StaleCount); err != nil {
		return nil, fmt.Errorf("memory health stale count: %w", err)
	}

	if err := s.db.QueryRow(
		`SELECT COALESCE(AVG(confidence), 0)
		 FROM memory_entries
		 WHERE superseded_by IS NULL`,
	).Scan(&summary.AverageQuality); err != nil {
		return nil, fmt.Errorf("memory health avg confidence: %w", err)
	}

	return summary, nil
}

func scanEntries(rows *sql.Rows) ([]*Entry, error) {
	entries := make([]*Entry, 0)
	for rows.Next() {
		entry, err := scanEntry(rows.Scan)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

func scanEntry(scan func(dest ...interface{}) error) (*Entry, error) {
	var e Entry
	var tagsJSON string
	var sourceTaskID, sourceInteractionID, supersededBy, sourceType sql.NullString
	var coveredAtCommit sql.NullString
	var stale int
	if err := scan(
		&e.ID,
		&e.Content,
		&e.Category,
		&tagsJSON,
		&sourceTaskID,
		&sourceInteractionID,
		&e.Confidence,
		&e.ProvenanceHash,
		&supersededBy,
		&sourceType,
		&coveredAtCommit,
		&stale,
		&e.CreatedAt,
		&e.UpdatedAt,
	); err != nil {
		return nil, err
	}

	tags, err := unmarshalTags(tagsJSON)
	if err != nil {
		return nil, fmt.Errorf("unmarshal tags for %s: %w", e.ID, err)
	}
	e.Tags = tags
	if sourceTaskID.Valid {
		e.SourceTaskID = sourceTaskID.String
	}
	if sourceInteractionID.Valid {
		e.SourceInteractionID = sourceInteractionID.String
	}
	if supersededBy.Valid {
		e.SupersededBy = supersededBy.String
	}
	if sourceType.Valid {
		e.SourceType = sourceType.String
	}
	if coveredAtCommit.Valid {
		e.CoveredAtCommit = strings.TrimSpace(coveredAtCommit.String)
	}
	e.Stale = stale == 1
	return &e, nil
}

func upsertFTS(tx *sql.Tx, id, content, tagsJSON string) error {
	if _, err := tx.Exec(`DELETE FROM memory_fts WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete memory fts row: %w", err)
	}
	if _, err := tx.Exec(
		`INSERT INTO memory_fts (id, content, tags) VALUES (?, ?, ?)`,
		id,
		content,
		tagsJSON,
	); err != nil {
		return fmt.Errorf("insert memory fts row: %w", err)
	}
	return nil
}

func marshalTags(tags []string) (string, error) {
	if tags == nil {
		tags = []string{}
	}
	raw, err := json.Marshal(tags)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func unmarshalTags(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return []string{}, nil
	}
	var tags []string
	if err := json.Unmarshal([]byte(raw), &tags); err != nil {
		return nil, err
	}
	if tags == nil {
		return []string{}, nil
	}
	return tags, nil
}

func nullableString(v string) interface{} {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}

func normalizeSourceType(sourceType string) (string, error) {
	sourceType = strings.TrimSpace(strings.ToLower(sourceType))
	if sourceType == "" {
		return "retro", nil
	}
	switch sourceType {
	case "retro", "explore":
		return sourceType, nil
	default:
		return "", fmt.Errorf("invalid source_type %q", sourceType)
	}
}

func normalizeFilePaths(paths []string) []string {
	if len(paths) == 0 {
		return nil
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

func (s *Store) associateFilesTx(tx *sql.Tx, entryID string, paths []string) error {
	for _, path := range paths {
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO memory_file_associations (memory_id, file_path) VALUES (?, ?)`,
			entryID,
			path,
		); err != nil {
			return fmt.Errorf("associate memory file %q: %w", path, err)
		}
	}
	return nil
}

func (s *Store) loadFilePaths(entries []*Entry) error {
	for _, entry := range entries {
		paths, err := s.GetFilePaths(entry.ID)
		if err != nil {
			return err
		}
		entry.FilePaths = paths
	}
	return nil
}

// buildFTSQuery converts raw text into an FTS5 MATCH expression.
// Each word is quoted to let FTS5's porter tokenizer handle stemming and
// normalization. Tokens are joined with OR for broad matching.
func buildFTSQuery(raw string) string {
	words := strings.Fields(raw)
	if len(words) == 0 {
		return ""
	}
	var tokens []string
	for _, w := range words {
		// FTS5 double-quote escaping: replace " with "" inside quoted strings
		escaped := strings.ReplaceAll(w, `"`, `""`)
		tokens = append(tokens, `"`+escaped+`"`)
	}
	return strings.Join(tokens, " OR ")
}
