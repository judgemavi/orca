package state

import (
	"context"
	"database/sql"
	"sort"
	"time"
)

// ChangeType identifies what happened to a task.
type ChangeType string

const (
	ChangeCreated ChangeType = "created"
	ChangeUpdated ChangeType = "updated"
	ChangeDeleted ChangeType = "deleted"
)

// TaskChange is a single detected task mutation.
type TaskChange struct {
	Type   ChangeType
	TaskID string
}

type SprintChange struct {
	Type     ChangeType
	SprintID string
}

type OperationChange struct {
	Type        ChangeType
	OperationID string
}

type SessionChange struct {
	Type      ChangeType
	SessionID string
}

// WatcherOpts configures watcher polling.
type WatcherOpts struct {
	Interval time.Duration // default 500ms if zero
}

type WatcherCallbacks struct {
	OnTaskChange      func([]TaskChange)
	OnSprintChange    func([]SprintChange)
	OnOperationChange func([]OperationChange)
	OnSessionChange   func([]SessionChange)
}

// Watcher polls db_version and emits typed table changes.
type Watcher struct {
	db             *DB
	lastVersion    int64
	lastTasks      map[string]time.Time // taskID -> last known updated_at
	lastSprints    map[string]string    // sprintID -> status
	lastOperations map[string]string    // operationID -> status
	lastSessions   map[string]string    // sessionID -> status

	onTaskChange      func([]TaskChange)
	onSprintChange    func([]SprintChange)
	onOperationChange func([]OperationChange)
	onSessionChange   func([]SessionChange)

	opts WatcherOpts
}

// NewWatcher creates a DB watcher.
func NewWatcher(db *DB, callbacks WatcherCallbacks, opts WatcherOpts) *Watcher {
	if opts.Interval == 0 {
		opts.Interval = 500 * time.Millisecond
	}
	return &Watcher{
		db:                db,
		lastVersion:       -1,
		lastTasks:         make(map[string]time.Time),
		lastSprints:       make(map[string]string),
		lastOperations:    make(map[string]string),
		lastSessions:      make(map[string]string),
		onTaskChange:      callbacks.OnTaskChange,
		onSprintChange:    callbacks.OnSprintChange,
		onOperationChange: callbacks.OnOperationChange,
		onSessionChange:   callbacks.OnSessionChange,
		opts:              opts,
	}
}

// Run polls until ctx is cancelled. Call in a goroutine.
func (w *Watcher) Run(ctx context.Context) {
	w.poll()

	ticker := time.NewTicker(w.opts.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.poll()
		}
	}
}

func (w *Watcher) poll() {
	version, err := w.db.DBVersion()
	if err != nil {
		return
	}
	if version == w.lastVersion {
		return
	}

	currentTasks, err := w.snapshotTasks()
	if err != nil {
		return
	}
	currentSprints, err := w.snapshotStatusTable(`SELECT id, status FROM sprints`)
	if err != nil {
		return
	}
	currentOperations, err := w.snapshotStatusTable(`SELECT id, status FROM operations`)
	if err != nil {
		return
	}
	currentSessions, err := w.snapshotStatusTable(`SELECT id, status FROM sessions`)
	if err != nil {
		return
	}

	// First observation initializes state without emitting synthetic events.
	if w.lastVersion == -1 {
		w.lastTasks = currentTasks
		w.lastSprints = currentSprints
		w.lastOperations = currentOperations
		w.lastSessions = currentSessions
		w.lastVersion = version
		return
	}

	taskChanges := diffTaskSnapshots(w.lastTasks, currentTasks)
	sprintChanges := diffStatusSnapshots(w.lastSprints, currentSprints, func(changeType ChangeType, id string) SprintChange {
		return SprintChange{Type: changeType, SprintID: id}
	})
	operationChanges := diffStatusSnapshots(w.lastOperations, currentOperations, func(changeType ChangeType, id string) OperationChange {
		return OperationChange{Type: changeType, OperationID: id}
	})
	sessionChanges := diffStatusSnapshots(w.lastSessions, currentSessions, func(changeType ChangeType, id string) SessionChange {
		return SessionChange{Type: changeType, SessionID: id}
	})

	w.lastTasks = currentTasks
	w.lastSprints = currentSprints
	w.lastOperations = currentOperations
	w.lastSessions = currentSessions
	w.lastVersion = version

	if len(taskChanges) > 0 && w.onTaskChange != nil {
		w.onTaskChange(taskChanges)
	}
	if len(sprintChanges) > 0 && w.onSprintChange != nil {
		w.onSprintChange(sprintChanges)
	}
	if len(operationChanges) > 0 && w.onOperationChange != nil {
		w.onOperationChange(operationChanges)
	}
	if len(sessionChanges) > 0 && w.onSessionChange != nil {
		w.onSessionChange(sessionChanges)
	}
}

func (w *Watcher) snapshotTasks() (map[string]time.Time, error) {
	rows, err := w.db.Query(`SELECT id, updated_at, created_at FROM tasks`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	snapshot := make(map[string]time.Time)
	for rows.Next() {
		var id string
		var updatedAt sql.NullTime
		var createdAt sql.NullTime
		if err := rows.Scan(&id, &updatedAt, &createdAt); err != nil {
			return nil, err
		}

		switch {
		case updatedAt.Valid:
			snapshot[id] = updatedAt.Time
		case createdAt.Valid:
			snapshot[id] = createdAt.Time
		default:
			snapshot[id] = time.Time{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return snapshot, nil
}

func (w *Watcher) snapshotStatusTable(query string) (map[string]string, error) {
	rows, err := w.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	snapshot := make(map[string]string)
	for rows.Next() {
		var id string
		var status string
		if err := rows.Scan(&id, &status); err != nil {
			return nil, err
		}
		snapshot[id] = status
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return snapshot, nil
}

func diffTaskSnapshots(previous, current map[string]time.Time) []TaskChange {
	changes := make([]TaskChange, 0)

	for id, currUpdatedAt := range current {
		prevUpdatedAt, ok := previous[id]
		if !ok {
			changes = append(changes, TaskChange{Type: ChangeCreated, TaskID: id})
			continue
		}
		if !currUpdatedAt.Equal(prevUpdatedAt) {
			changes = append(changes, TaskChange{Type: ChangeUpdated, TaskID: id})
		}
	}

	for id := range previous {
		if _, ok := current[id]; !ok {
			changes = append(changes, TaskChange{Type: ChangeDeleted, TaskID: id})
		}
	}

	sort.Slice(changes, func(i, j int) bool {
		if changes[i].TaskID != changes[j].TaskID {
			return changes[i].TaskID < changes[j].TaskID
		}
		return changes[i].Type < changes[j].Type
	})

	return changes
}

func diffStatusSnapshots[T any](previous, current map[string]string, newChange func(changeType ChangeType, id string) T) []T {
	changes := make([]T, 0)
	ids := make([]string, 0, len(previous)+len(current))
	seen := make(map[string]struct{}, len(previous)+len(current))

	for id := range previous {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for id := range current {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, id := range ids {
		prevStatus, prevOK := previous[id]
		currStatus, currOK := current[id]
		switch {
		case !prevOK && currOK:
			changes = append(changes, newChange(ChangeCreated, id))
		case prevOK && !currOK:
			changes = append(changes, newChange(ChangeDeleted, id))
		case prevOK && currOK && prevStatus != currStatus:
			changes = append(changes, newChange(ChangeUpdated, id))
		}
	}
	return changes
}
