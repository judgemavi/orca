package memory

import (
	"strings"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/testutil"
)

func TestCreateGetUpdateDelete(t *testing.T) {
	store, db := setupStore(t)

	entry := &Entry{
		Content:        "Prefer table-driven tests for parser cases",
		Category:       "pattern",
		Tags:           []string{"go", "testing"},
		SourceType:     "explore",
		FilePaths:      []string{"internal/memory/memory.go", "internal/memory/memory_test.go"},
		ProvenanceHash: "hash-crud-1",
	}
	if err := store.Create(entry); err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(entry.ID) != 36 {
		t.Fatalf("id length = %d, want 36", len(entry.ID))
	}
	if entry.Confidence != 1.0 {
		t.Fatalf("confidence = %v, want 1.0 default", entry.Confidence)
	}

	got, err := store.Get(entry.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Content != entry.Content {
		t.Fatalf("content = %q, want %q", got.Content, entry.Content)
	}
	if len(got.Tags) != 2 || got.Tags[0] != "go" || got.Tags[1] != "testing" {
		t.Fatalf("tags = %v, want [go testing]", got.Tags)
	}
	if got.SourceType != "explore" {
		t.Fatalf("source_type = %q, want explore", got.SourceType)
	}
	if len(got.FilePaths) != 2 {
		t.Fatalf("file_paths len = %d, want 2", len(got.FilePaths))
	}

	var tagsRaw, sourceTypeRaw string
	if err := db.QueryRow(`SELECT tags, source_type FROM memory_entries WHERE id = ?`, entry.ID).Scan(&tagsRaw, &sourceTypeRaw); err != nil {
		t.Fatalf("read tags/source_type: %v", err)
	}
	if tagsRaw != `["go","testing"]` {
		t.Fatalf("stored tags = %q, want JSON array", tagsRaw)
	}
	if sourceTypeRaw != "explore" {
		t.Fatalf("stored source_type = %q, want explore", sourceTypeRaw)
	}

	var ftsRows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM memory_fts WHERE id = ?`, entry.ID).Scan(&ftsRows); err != nil {
		t.Fatalf("count fts rows: %v", err)
	}
	if ftsRows != 1 {
		t.Fatalf("fts rows = %d, want 1", ftsRows)
	}

	if err := store.Update(entry.ID, UpdateFields{
		Content:    Ptr("Updated: prefer focused, narrow unit tests"),
		Tags:       []string{"go", "unit"},
		Confidence: Ptr(0.75),
		SourceType: Ptr("retro"),
	}); err != nil {
		t.Fatalf("update: %v", err)
	}

	searchOld, err := store.Search("table driven parser", 10)
	if err != nil {
		t.Fatalf("search old: %v", err)
	}
	if len(searchOld) != 0 {
		t.Fatalf("old content still present in fts: %d matches", len(searchOld))
	}

	searchNew, err := store.Search("focused narrow unit tests", 10)
	if err != nil {
		t.Fatalf("search new: %v", err)
	}
	if len(searchNew) != 1 || searchNew[0].ID != entry.ID {
		t.Fatalf("new content missing from fts, got %d matches", len(searchNew))
	}

	updated, err := store.Get(entry.ID)
	if err != nil {
		t.Fatalf("get updated: %v", err)
	}
	if updated.Confidence != 0.75 {
		t.Fatalf("confidence = %v, want 0.75", updated.Confidence)
	}
	if len(updated.Tags) != 2 || updated.Tags[1] != "unit" {
		t.Fatalf("tags after update = %v", updated.Tags)
	}
	if updated.SourceType != "retro" {
		t.Fatalf("source_type after update = %q, want retro", updated.SourceType)
	}

	if err := store.Delete(entry.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := store.Get(entry.ID); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("get after delete err = %v, want not found", err)
	}

	if err := db.QueryRow(`SELECT COUNT(*) FROM memory_entries WHERE id = ?`, entry.ID).Scan(&ftsRows); err != nil {
		t.Fatalf("count entries rows after delete: %v", err)
	}
	if ftsRows != 0 {
		t.Fatalf("entries rows after delete = %d, want 0", ftsRows)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM memory_fts WHERE id = ?`, entry.ID).Scan(&ftsRows); err != nil {
		t.Fatalf("count fts rows after delete: %v", err)
	}
	if ftsRows != 0 {
		t.Fatalf("fts rows after delete = %d, want 0", ftsRows)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM memory_file_associations WHERE memory_id = ?`, entry.ID).Scan(&ftsRows); err != nil {
		t.Fatalf("count file associations after delete: %v", err)
	}
	if ftsRows != 0 {
		t.Fatalf("file associations after delete = %d, want 0", ftsRows)
	}
}

func TestListWithFiltersAndSupersededExclusion(t *testing.T) {
	store, _ := setupStore(t)

	pattern := mustCreateEntry(t, store, "Use clear naming and stable APIs", "pattern", []string{"go", "style"}, 0.9, "hash-list-1")
	pitfall := mustCreateEntry(t, store, "Avoid hidden state across tests", "pitfall", []string{"go", "testing"}, 0.9, "hash-list-2")
	superseded := mustCreateEntry(t, store, "Old style rule", "pattern", []string{"legacy"}, 0.9, "hash-list-3")
	mustCreateEntry(t, store, "Document team conventions", "convention", []string{"docs"}, 0.9, "hash-list-4")

	if err := store.Supersede(superseded.ID, pattern.ID); err != nil {
		t.Fatalf("supersede: %v", err)
	}

	all, err := store.List(ListOpts{})
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("list all count = %d, want 3 non-superseded entries", len(all))
	}

	byCategory, err := store.List(ListOpts{Category: "pattern"})
	if err != nil {
		t.Fatalf("list by category: %v", err)
	}
	if len(byCategory) != 1 || byCategory[0].ID != pattern.ID {
		t.Fatalf("list by category returned %v, want only %s", entryIDs(byCategory), pattern.ID)
	}

	byTag, err := store.List(ListOpts{Tag: "go"})
	if err != nil {
		t.Fatalf("list by tag: %v", err)
	}
	if len(byTag) != 2 {
		t.Fatalf("list by tag count = %d, want 2", len(byTag))
	}

	combined, err := store.List(ListOpts{Category: "pitfall", Tag: "testing"})
	if err != nil {
		t.Fatalf("list by combined filters: %v", err)
	}
	if len(combined) != 1 || combined[0].ID != pitfall.ID {
		t.Fatalf("list by combined filters returned %v, want only %s", entryIDs(combined), pitfall.ID)
	}
}

func TestSearchAndSearchExcluding(t *testing.T) {
	store, _ := setupStore(t)

	top := mustCreateEntry(t, store,
		"Concurrency fanout with buffered channels and bounded workers fanout fanout",
		"pattern",
		[]string{"go", "concurrency"},
		0.95,
		"hash-search-top",
	)
	mid := mustCreateEntry(t, store,
		"Concurrency fanout with channels and bounded workers",
		"pattern",
		[]string{"go"},
		0.85,
		"hash-search-mid",
	)
	lowConfidence := mustCreateEntry(t, store,
		"Concurrency fanout workers channels",
		"pattern",
		[]string{"go"},
		0.2,
		"hash-search-low",
	)
	old := mustCreateEntry(t, store,
		"Concurrency fanout workers channels old approach",
		"pattern",
		[]string{"legacy"},
		0.9,
		"hash-search-old",
	)
	if err := store.Supersede(old.ID, top.ID); err != nil {
		t.Fatalf("supersede old: %v", err)
	}

	searchQuery := "concurrency fanout channels workers"
	results, err := store.Search(searchQuery, 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("search count = %d, want 2 (exclude low confidence + superseded)", len(results))
	}
	if results[0].ID != top.ID {
		t.Fatalf("first result id = %s, want %s for bm25 relevance ordering", results[0].ID, top.ID)
	}

	excluding, err := store.SearchExcluding(searchQuery, 10, []string{top.ProvenanceHash})
	if err != nil {
		t.Fatalf("search excluding: %v", err)
	}
	if len(excluding) != 1 || excluding[0].ID != mid.ID {
		t.Fatalf("search excluding returned %v, want only %s", entryIDs(excluding), mid.ID)
	}

	limited, err := store.Search(searchQuery, 1)
	if err != nil {
		t.Fatalf("search limited: %v", err)
	}
	if len(limited) != 1 {
		t.Fatalf("search limited count = %d, want 1", len(limited))
	}

	if lowConfidence.ID == "" {
		t.Fatal("lowConfidence entry ID should be set")
	}
}

func TestDecayConfidence(t *testing.T) {
	store, db := setupStore(t)

	toDecay := mustCreateEntry(t, store, "Decays when stale and unused", "pattern", []string{"decay"}, 1.0, "hash-decay-1")
	used := mustCreateEntry(t, store, "Used recently, should not decay", "pattern", []string{"decay"}, 0.8, "hash-decay-2")
	recent := mustCreateEntry(t, store, "Recently updated, should not decay", "pattern", []string{"decay"}, 0.9, "hash-decay-3")
	low := mustCreateEntry(t, store, "Low confidence floor", "pattern", []string{"decay"}, 0.1, "hash-decay-4")
	superseded := mustCreateEntry(t, store, "Superseded stale", "pattern", []string{"decay"}, 0.9, "hash-decay-5")

	if err := store.Supersede(superseded.ID, toDecay.ID); err != nil {
		t.Fatalf("supersede stale entry: %v", err)
	}

	oldTime := time.Now().UTC().Add(-72 * time.Hour)
	for _, id := range []string{toDecay.ID, used.ID, low.ID, superseded.ID} {
		if _, err := db.Exec(`UPDATE memory_entries SET updated_at = ? WHERE id = ?`, oldTime, id); err != nil {
			t.Fatalf("set old updated_at for %s: %v", id, err)
		}
	}

	qualityJSON := `{"used_memory_ids":["` + used.ID + `"]}`
	if _, err := db.Exec(
		`INSERT INTO task_interactions (id, phase, tool, log_path, status, quality_json, finished_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"interaction-decay-1",
		"plan",
		"codex",
		"/tmp/interaction-decay-1.log",
		"completed",
		qualityJSON,
		time.Now().UTC(),
	); err != nil {
		t.Fatalf("insert interaction with used ids: %v", err)
	}

	decayed, err := store.DecayConfidence(24*time.Hour, 0.5)
	if err != nil {
		t.Fatalf("decay confidence: %v", err)
	}
	if decayed != 1 {
		t.Fatalf("decayed count = %d, want 1", decayed)
	}

	gotToDecay, err := store.Get(toDecay.ID)
	if err != nil {
		t.Fatalf("get toDecay: %v", err)
	}
	if gotToDecay.Confidence != 0.5 {
		t.Fatalf("toDecay confidence = %v, want 0.5", gotToDecay.Confidence)
	}

	gotUsed, err := store.Get(used.ID)
	if err != nil {
		t.Fatalf("get used: %v", err)
	}
	if gotUsed.Confidence != 0.8 {
		t.Fatalf("used confidence = %v, want 0.8", gotUsed.Confidence)
	}

	gotRecent, err := store.Get(recent.ID)
	if err != nil {
		t.Fatalf("get recent: %v", err)
	}
	if gotRecent.Confidence != 0.9 {
		t.Fatalf("recent confidence = %v, want 0.9", gotRecent.Confidence)
	}

	gotLow, err := store.Get(low.ID)
	if err != nil {
		t.Fatalf("get low: %v", err)
	}
	if gotLow.Confidence != 0.1 {
		t.Fatalf("low confidence = %v, want 0.1", gotLow.Confidence)
	}

	gotSuperseded, err := store.Get(superseded.ID)
	if err != nil {
		t.Fatalf("get superseded: %v", err)
	}
	if gotSuperseded.Confidence != 0.9 {
		t.Fatalf("superseded confidence = %v, want 0.9", gotSuperseded.Confidence)
	}
}

func TestAssociateFilesGetFilePathsAndFindByFilePaths(t *testing.T) {
	store, _ := setupStore(t)

	first := mustCreateEntry(t, store, "First entry", "pattern", []string{"a"}, 0.9, "hash-files-1")
	second := mustCreateEntry(t, store, "Second entry", "pitfall", []string{"b"}, 0.9, "hash-files-2")

	if err := store.AssociateFiles(first.ID, []string{"internal/api/server.go", "internal/api/server.go", "internal/memory/memory.go"}); err != nil {
		t.Fatalf("associate first files: %v", err)
	}
	if err := store.AssociateFiles(second.ID, []string{"internal/api/server.go"}); err != nil {
		t.Fatalf("associate second files: %v", err)
	}

	paths, err := store.GetFilePaths(first.ID)
	if err != nil {
		t.Fatalf("get file paths: %v", err)
	}
	if len(paths) != 2 {
		t.Fatalf("file paths len = %d, want 2", len(paths))
	}
	if paths[0] != "internal/api/server.go" || paths[1] != "internal/memory/memory.go" {
		t.Fatalf("file paths = %v", paths)
	}

	found, err := store.FindByFilePaths([]string{"internal/api/server.go"})
	if err != nil {
		t.Fatalf("find by file path: %v", err)
	}
	if len(found) != 2 {
		t.Fatalf("found len = %d, want 2", len(found))
	}

	if err := store.Supersede(first.ID, second.ID); err != nil {
		t.Fatalf("supersede first: %v", err)
	}
	found, err = store.FindByFilePaths([]string{"internal/api/server.go"})
	if err != nil {
		t.Fatalf("find by file path after supersede: %v", err)
	}
	if len(found) != 1 || found[0].ID != second.ID {
		t.Fatalf("found after supersede = %v, want only %s", entryIDs(found), second.ID)
	}
}

func TestListFiltersBySourceTypeAndFilePath(t *testing.T) {
	store, _ := setupStore(t)

	retro := mustCreateEntryWithOptions(
		t, store, "Retro entry", "pattern", []string{"retro"}, 0.9, "hash-list-source-1", "retro", []string{"internal/state/state.go"},
	)
	explore := mustCreateEntryWithOptions(
		t, store, "Explore entry", "architecture", []string{"explore"}, 0.9, "hash-list-source-2", "explore", []string{"internal/state/state.go"},
	)
	_ = mustCreateEntryWithOptions(
		t, store, "Retro readme entry", "dependency", []string{"retro"}, 0.9, "hash-list-source-3", "retro", []string{"README.md"},
	)

	bySourceType, err := store.List(ListOpts{SourceType: "explore"})
	if err != nil {
		t.Fatalf("list by source type: %v", err)
	}
	if len(bySourceType) != 1 || bySourceType[0].ID != explore.ID {
		t.Fatalf("source type filter got %v, want only %s", entryIDs(bySourceType), explore.ID)
	}

	byFilePath, err := store.List(ListOpts{FilePath: "internal/state/state.go"})
	if err != nil {
		t.Fatalf("list by file path: %v", err)
	}
	if len(byFilePath) != 2 {
		t.Fatalf("file path filter count = %d, want 2", len(byFilePath))
	}

	combined, err := store.List(ListOpts{SourceType: "retro", FilePath: "internal/state/state.go"})
	if err != nil {
		t.Fatalf("list by combined source/file: %v", err)
	}
	if len(combined) != 1 || combined[0].ID != retro.ID {
		t.Fatalf("combined filter got %v, want only %s", entryIDs(combined), retro.ID)
	}
}

func TestBoostConfidenceAndDecayEntry(t *testing.T) {
	store, _ := setupStore(t)

	entry := mustCreateEntry(t, store, "Confidence target", "pattern", []string{"confidence"}, 0.95, "hash-conf-1")
	if err := store.BoostConfidence(entry.ID, 1.1); err != nil {
		t.Fatalf("boost confidence: %v", err)
	}
	got, err := store.Get(entry.ID)
	if err != nil {
		t.Fatalf("get boosted entry: %v", err)
	}
	if got.Confidence != 1.0 {
		t.Fatalf("boosted confidence = %v, want 1.0 cap", got.Confidence)
	}

	if err := store.DecayEntry(entry.ID, 0.5); err != nil {
		t.Fatalf("decay entry: %v", err)
	}
	got, err = store.Get(entry.ID)
	if err != nil {
		t.Fatalf("get decayed entry: %v", err)
	}
	if got.Confidence != 0.5 {
		t.Fatalf("decayed confidence = %v, want 0.5", got.Confidence)
	}

	low := mustCreateEntry(t, store, "Low floor", "pattern", []string{"confidence"}, 0.1, "hash-conf-2")
	if err := store.DecayEntry(low.ID, 0.2); err != nil {
		t.Fatalf("decay low entry: %v", err)
	}
	got, err = store.Get(low.ID)
	if err != nil {
		t.Fatalf("get low entry: %v", err)
	}
	if got.Confidence != 0.1 {
		t.Fatalf("low entry confidence = %v, want floor 0.1", got.Confidence)
	}
}

func TestProvenanceHashLookupIncludesSupersededEntries(t *testing.T) {
	store, _ := setupStore(t)

	oldEntry := mustCreateEntry(t, store, "Old guidance", "pattern", []string{"legacy"}, 0.9, "hash-provenance-1")
	newEntry := mustCreateEntry(t, store, "Replacement guidance", "pattern", []string{"new"}, 0.95, "hash-provenance-2")

	if err := store.Supersede(oldEntry.ID, newEntry.ID); err != nil {
		t.Fatalf("supersede old entry: %v", err)
	}

	found, err := store.HasProvenanceHash("hash-provenance-1")
	if err != nil {
		t.Fatalf("has provenance hash: %v", err)
	}
	if !found {
		t.Fatal("expected superseded provenance hash to be discoverable")
	}

	entry, err := store.GetByProvenanceHash("hash-provenance-1")
	if err != nil {
		t.Fatalf("get by provenance hash: %v", err)
	}
	if entry == nil || entry.ID != oldEntry.ID {
		t.Fatalf("unexpected entry from provenance lookup: %#v", entry)
	}

	missing, err := store.GetByProvenanceHash("missing-hash")
	if err != nil {
		t.Fatalf("get missing provenance hash: %v", err)
	}
	if missing != nil {
		t.Fatalf("missing provenance hash returned entry: %#v", missing)
	}
}

func TestFindUsedByTasks(t *testing.T) {
	store, db := setupStore(t)

	entry := mustCreateEntryWithOptions(
		t,
		store,
		"Authentication middleware validates JWT",
		"pattern",
		[]string{"auth"},
		0.9,
		"hash-used-by-1",
		"explore",
		[]string{"internal/api/middleware.go"},
	)

	now := time.Now().UTC()
	if _, err := db.Exec(
		`INSERT INTO tasks (id, title, description, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		"task-memory-used-1",
		"Add auth endpoint",
		"Wire auth endpoint",
		"running",
		now,
		now,
	); err != nil {
		t.Fatalf("insert task: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO task_interactions (id, task_id, phase, tool, log_path, status, quality_json, started_at, finished_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"interaction-memory-used-1",
		"task-memory-used-1",
		"plan",
		"codex",
		"/tmp/interaction-memory-used-1.log",
		"completed",
		`{"used_memory_ids":["`+entry.ID+`"]}`,
		now,
		now,
	); err != nil {
		t.Fatalf("insert interaction: %v", err)
	}

	usedBy, err := store.FindUsedByTasks(entry.ID)
	if err != nil {
		t.Fatalf("find used-by tasks: %v", err)
	}
	if len(usedBy) != 1 {
		t.Fatalf("used by len = %d, want 1", len(usedBy))
	}
	if usedBy[0].TaskID != "task-memory-used-1" {
		t.Fatalf("used by task id = %q, want task-memory-used-1", usedBy[0].TaskID)
	}
}

func TestBuildHealthSummary(t *testing.T) {
	store, _ := setupStore(t)

	retro := mustCreateEntryWithOptions(
		t, store, "Retro rule", "pattern", []string{"retro"}, 0.8, "hash-health-1", "retro", []string{"internal/a.go"},
	)
	_ = mustCreateEntryWithOptions(
		t, store, "Explore rule", "architecture", []string{"explore"}, 0.9, "hash-health-2", "explore", []string{"internal/b.go"},
	)
	if err := store.MarkStale(retro.ID); err != nil {
		t.Fatalf("mark stale: %v", err)
	}

	summary, err := store.BuildHealthSummary()
	if err != nil {
		t.Fatalf("build health summary: %v", err)
	}
	if summary.TotalEntries != 2 {
		t.Fatalf("total entries = %d, want 2", summary.TotalEntries)
	}
	if summary.StaleCount != 1 {
		t.Fatalf("stale count = %d, want 1", summary.StaleCount)
	}
	if summary.BySource["retro"] != 1 || summary.BySource["explore"] != 1 {
		t.Fatalf("by source = %v, want retro=1 explore=1", summary.BySource)
	}
	if summary.AverageQuality <= 0 {
		t.Fatalf("avg confidence = %f, want > 0", summary.AverageQuality)
	}
}

func setupStore(t *testing.T) (*Store, *state.DB) {
	t.Helper()
	db := testutil.DB(t)
	return NewStore(db), db
}

func mustCreateEntry(
	t *testing.T,
	store *Store,
	content, category string,
	tags []string,
	confidence float64,
	hash string,
) *Entry {
	t.Helper()
	return mustCreateEntryWithOptions(t, store, content, category, tags, confidence, hash, "", nil)
}

func mustCreateEntryWithOptions(
	t *testing.T,
	store *Store,
	content, category string,
	tags []string,
	confidence float64,
	hash string,
	sourceType string,
	filePaths []string,
) *Entry {
	t.Helper()
	entry := &Entry{
		Content:        content,
		Category:       category,
		Tags:           tags,
		Confidence:     confidence,
		SourceType:     sourceType,
		FilePaths:      filePaths,
		ProvenanceHash: hash,
	}
	if err := store.Create(entry); err != nil {
		t.Fatalf("create entry %q: %v", content, err)
	}
	return entry
}

func entryIDs(entries []*Entry) []string {
	ids := make([]string, 0, len(entries))
	for _, e := range entries {
		ids = append(ids, e.ID)
	}
	return ids
}
