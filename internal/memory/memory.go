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
	confidence, provenance_hash, superseded_by, created_at, updated_at
`

const entryColumnsQualified = `
	ke.id, ke.content, ke.category, ke.tags, ke.source_task_id, ke.source_interaction_id,
	ke.confidence, ke.provenance_hash, ke.superseded_by, ke.created_at, ke.updated_at
`

// Entry is a single memory row persisted in SQLite.
type Entry struct {
	ID                  string    `json:"id"`
	Content             string    `json:"content"`
	Category            string    `json:"category"`
	Tags                []string  `json:"tags"`
	SourceTaskID        string    `json:"source_task_id,omitempty"`
	SourceInteractionID string    `json:"source_interaction_id,omitempty"`
	Confidence          float64   `json:"confidence"`
	ProvenanceHash      string    `json:"provenance_hash"`
	SupersededBy        string    `json:"superseded_by,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

// ListOpts controls list filtering.
type ListOpts struct {
	Category string
	Tag      string
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

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin create memory entry: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT INTO memory_entries (
			id, content, category, tags, source_task_id, source_interaction_id,
			confidence, provenance_hash, superseded_by, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		e.Content,
		e.Category,
		tagsJSON,
		nullableString(e.SourceTaskID),
		nullableString(e.SourceInteractionID),
		confidence,
		e.ProvenanceHash,
		nullableString(e.SupersededBy),
		now,
		now,
	); err != nil {
		return fmt.Errorf("insert memory entry: %w", err)
	}

	if err := upsertFTS(tx, id, e.Content, tagsJSON); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit create memory entry: %w", err)
	}

	e.ID = id
	e.Confidence = confidence
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
	args := make([]interface{}, 0, 2)

	if strings.TrimSpace(opts.Category) != "" {
		sb.WriteString(` AND category = ?`)
		args = append(args, opts.Category)
	}
	if strings.TrimSpace(opts.Tag) != "" {
		sb.WriteString(` AND tags LIKE ?`)
		args = append(args, fmt.Sprintf("%%\"%s\"%%", opts.Tag))
	}
	sb.WriteString(` ORDER BY created_at`)

	rows, err := s.db.Query(sb.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list memory entries: %w", err)
	}
	defer rows.Close()
	return scanEntries(rows)
}

func (s *Store) Update(id string, updates map[string]interface{}) error {
	if len(updates) == 0 {
		return nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin update memory entry: %w", err)
	}
	defer tx.Rollback()

	keys := make([]string, 0, len(updates))
	for k := range updates {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	setClauses := make([]string, 0, len(keys)+1)
	args := make([]interface{}, 0, len(keys)+2)
	for _, key := range keys {
		val, err := normalizeUpdateValue(key, updates[key])
		if err != nil {
			return err
		}
		setClauses = append(setClauses, key+" = ?")
		args = append(args, val)
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
	return scanEntries(rows)
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
	var sourceTaskID, sourceInteractionID, supersededBy sql.NullString
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
	return &e, nil
}

func normalizeUpdateValue(key string, value interface{}) (interface{}, error) {
	switch key {
	case "content", "category", "confidence", "provenance_hash":
		return value, nil
	case "source_task_id", "source_interaction_id", "superseded_by":
		return nullableAnyString(value)
	case "tags":
		return normalizeTagsValue(value)
	default:
		return nil, fmt.Errorf("unsupported update field %q", key)
	}
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

func normalizeTagsValue(value interface{}) (string, error) {
	switch v := value.(type) {
	case nil:
		return marshalTags(nil)
	case []string:
		return marshalTags(v)
	case []interface{}:
		tags := make([]string, 0, len(v))
		for _, tag := range v {
			s, ok := tag.(string)
			if !ok {
				return "", fmt.Errorf("tags update must contain only strings")
			}
			tags = append(tags, s)
		}
		return marshalTags(tags)
	default:
		return "", fmt.Errorf("tags update must be []string")
	}
}

func nullableAnyString(value interface{}) (interface{}, error) {
	switch v := value.(type) {
	case nil:
		return nil, nil
	case string:
		return nullableString(v), nil
	default:
		return nil, fmt.Errorf("value must be string or nil")
	}
}

func nullableString(v string) interface{} {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
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
