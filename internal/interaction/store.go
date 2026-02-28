package interaction

import (
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/state"
)

// ToolSummary aggregates cost data per tool.
type ToolSummary struct {
	Tool         string  `json:"tool"`
	InputTokens  int64   `json:"input_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	Cost         float64 `json:"cost"`
}

// Store persists interaction rows and log files.
type Store struct {
	db      *state.DB
	baseDir string
}

// Interaction captures a single LLM/tool engagement.
type Interaction struct {
	ID            string     `json:"id"`
	TaskID        *string    `json:"task_id,omitempty"`
	Phase         string     `json:"phase"`
	Attempt       int        `json:"attempt"`
	RunID         *string    `json:"run_id,omitempty"`
	Tool          string     `json:"tool"`
	Model         string     `json:"model,omitempty"`
	LogPath       string     `json:"log_path"`
	Status        string     `json:"status"`
	Error         string     `json:"error,omitempty"`
	Diff          string     `json:"diff,omitempty"`
	ExitCode      *int       `json:"exit_code,omitempty"`
	DurationMS    *int       `json:"duration_ms,omitempty"`
	QualityJSON   string     `json:"quality_json,omitempty"`
	InputTokens   int64      `json:"input_tokens"`
	OutputTokens  int64      `json:"output_tokens"`
	EstimatedCost float64    `json:"estimated_cost"`
	StartedAt     time.Time  `json:"started_at"`
	FinishedAt    *time.Time `json:"finished_at,omitempty"`
}

// FinishOptions for setting result fields on completion.
type FinishOption func(*finishConfig)

type finishConfig struct {
	error       *string
	diff        *string
	exitCode    *int
	durationMS  *int
	qualityJSON *string
	cost        *costFields
	runID       *string
	model       *string
}

type costFields struct {
	inputTokens   int64
	outputTokens  int64
	estimatedCost float64
}

func (s *Store) nextAttempt(taskID *string, phase string) (int, error) {
	var attempt int
	err := s.db.QueryRow(
		`SELECT COALESCE(MAX(attempt), 0) + 1
		 FROM task_interactions
		 WHERE phase = ?
		   AND ((task_id IS NULL AND ? IS NULL) OR task_id = ?)`,
		phase, taskID, taskID,
	).Scan(&attempt)
	if err != nil {
		return 0, fmt.Errorf("resolve attempt: %w", err)
	}
	return attempt, nil
}

func (s *Store) logPath(taskID *string, phase string, attempt int, id string) string {
	dir := "_project"
	if taskID != nil && strings.TrimSpace(*taskID) != "" {
		dir = *taskID
	}
	filename := fmt.Sprintf("%s-%d-%s.log", phase, attempt, id)
	return filepath.ToSlash(filepath.Join(s.baseDir, dir, filename))
}

func (s *Store) createLogFile(logPath string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return nil, fmt.Errorf("create interaction log directory: %w", err)
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("create interaction log file: %w", err)
	}
	return f, nil
}

func readInteractions(rows *sql.Rows) ([]Interaction, error) {
	out := make([]Interaction, 0)
	for rows.Next() {
		in, err := scanInteraction(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, *in)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanInteraction(scan func(dest ...interface{}) error) (*Interaction, error) {
	var in Interaction
	var taskID, runID, model, errText, diff, quality sql.NullString
	var exitCode, durationMS sql.NullInt64
	var finishedAt sql.NullTime
	if err := scan(
		&in.ID,
		&taskID,
		&in.Phase,
		&in.Attempt,
		&runID,
		&in.Tool,
		&model,
		&in.LogPath,
		&in.Status,
		&errText,
		&diff,
		&exitCode,
		&durationMS,
		&quality,
		&in.InputTokens,
		&in.OutputTokens,
		&in.EstimatedCost,
		&in.StartedAt,
		&finishedAt,
	); err != nil {
		return nil, err
	}
	if taskID.Valid {
		v := taskID.String
		in.TaskID = &v
	}
	if runID.Valid {
		v := runID.String
		in.RunID = &v
	}
	if model.Valid {
		in.Model = model.String
	}
	if errText.Valid {
		in.Error = errText.String
	}
	if diff.Valid {
		in.Diff = diff.String
	}
	if exitCode.Valid {
		v := int(exitCode.Int64)
		in.ExitCode = &v
	}
	if durationMS.Valid {
		v := int(durationMS.Int64)
		in.DurationMS = &v
	}
	if quality.Valid {
		in.QualityJSON = quality.String
	}
	if finishedAt.Valid {
		v := finishedAt.Time
		in.FinishedAt = &v
	}
	return &in, nil
}

func readToolSummaries(rows *sql.Rows) ([]ToolSummary, error) {
	var summaries []ToolSummary
	for rows.Next() {
		var s ToolSummary
		if err := rows.Scan(&s.Tool, &s.InputTokens, &s.OutputTokens, &s.Cost); err != nil {
			return nil, err
		}
		summaries = append(summaries, s)
	}
	return summaries, rows.Err()
}

func nullableString(v string) interface{} {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}

func NewStore(db *state.DB, baseDir string) *Store {
	base := strings.TrimSpace(baseDir)
	if base == "" {
		base = ".orca/interactions"
	}
	return &Store{db: db, baseDir: base}
}

// Begin creates an interaction row (status=running) and opens a log file writer.
func (s *Store) Begin(taskID *string, phase, tool string) (*Writer, error) {
	if strings.TrimSpace(phase) == "" {
		return nil, fmt.Errorf("phase required")
	}
	if strings.TrimSpace(tool) == "" {
		return nil, fmt.Errorf("tool required")
	}

	id := uuid.New().String()
	attempt, err := s.nextAttempt(taskID, phase)
	if err != nil {
		return nil, err
	}
	logPath := s.logPath(taskID, phase, attempt, id)

	file, err := s.createLogFile(logPath)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	_, err = s.db.Exec(
		`INSERT INTO task_interactions (
			id, task_id, phase, attempt, tool, log_path, status, started_at
		 ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
		id, taskID, phase, attempt, tool, logPath, now,
	)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("create interaction: %w", err)
	}
	return &Writer{id: id, file: file}, nil
}

func (s *Store) Finish(id, status string, opts ...FinishOption) error {
	cfg := finishConfig{}
	for _, opt := range opts {
		opt(&cfg)
	}

	var setters []string
	var args []interface{}

	setters = append(setters, "status = ?")
	args = append(args, status)

	if cfg.error != nil {
		setters = append(setters, "error = ?")
		args = append(args, nullableString(*cfg.error))
	}
	if cfg.diff != nil {
		setters = append(setters, "diff = ?")
		args = append(args, nullableString(*cfg.diff))
	}
	if cfg.exitCode != nil {
		setters = append(setters, "exit_code = ?")
		args = append(args, *cfg.exitCode)
	}
	if cfg.durationMS != nil {
		setters = append(setters, "duration_ms = ?")
		args = append(args, *cfg.durationMS)
	}
	if cfg.qualityJSON != nil {
		setters = append(setters, "quality_json = ?")
		args = append(args, nullableString(*cfg.qualityJSON))
	}
	if cfg.cost != nil {
		setters = append(setters, "input_tokens = ?", "output_tokens = ?", "estimated_cost = ?")
		args = append(args, cfg.cost.inputTokens, cfg.cost.outputTokens, cfg.cost.estimatedCost)
	}
	if cfg.runID != nil {
		setters = append(setters, "run_id = ?")
		args = append(args, nullableString(*cfg.runID))
	}
	if cfg.model != nil {
		setters = append(setters, "model = ?")
		args = append(args, nullableString(*cfg.model))
	}

	now := time.Now().UTC()
	setters = append(setters, "finished_at = ?")
	args = append(args, now, id)

	query := `UPDATE task_interactions SET ` + strings.Join(setters, ", ") + ` WHERE id = ?`
	res, err := s.db.Exec(query, args...)
	if err != nil {
		return fmt.Errorf("finish interaction: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("finish interaction rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("interaction %s not found", id)
	}
	return nil
}

func WithError(msg string) FinishOption {
	return func(c *finishConfig) { c.error = &msg }
}

func WithDiff(diff string) FinishOption {
	return func(c *finishConfig) { c.diff = &diff }
}

func WithExitCode(code int) FinishOption {
	return func(c *finishConfig) { c.exitCode = &code }
}

func WithDuration(d time.Duration) FinishOption {
	ms := int(d.Milliseconds())
	return func(c *finishConfig) { c.durationMS = &ms }
}

func WithQuality(json string) FinishOption {
	return func(c *finishConfig) { c.qualityJSON = &json }
}

func WithCost(inputTokens, outputTokens int64, cost float64) FinishOption {
	return func(c *finishConfig) {
		c.cost = &costFields{inputTokens: inputTokens, outputTokens: outputTokens, estimatedCost: cost}
	}
}

func WithRunID(runID string) FinishOption {
	return func(c *finishConfig) { c.runID = &runID }
}

func WithModel(model string) FinishOption {
	return func(c *finishConfig) { c.model = &model }
}

func (s *Store) List(taskID string) ([]Interaction, error) {
	rows, err := s.db.Query(
		`SELECT id, task_id, phase, attempt, run_id, tool, model, log_path, status, error,
			diff, exit_code, duration_ms, quality_json, input_tokens, output_tokens,
			estimated_cost, started_at, finished_at
		 FROM task_interactions WHERE task_id = ? ORDER BY started_at DESC`,
		taskID,
	)
	if err != nil {
		return nil, fmt.Errorf("list interactions: %w", err)
	}
	defer rows.Close()
	return readInteractions(rows)
}

func (s *Store) ListByPhase(taskID, phase string) ([]Interaction, error) {
	rows, err := s.db.Query(
		`SELECT id, task_id, phase, attempt, run_id, tool, model, log_path, status, error,
			diff, exit_code, duration_ms, quality_json, input_tokens, output_tokens,
			estimated_cost, started_at, finished_at
		 FROM task_interactions WHERE task_id = ? AND phase = ? ORDER BY started_at DESC`,
		taskID, phase,
	)
	if err != nil {
		return nil, fmt.Errorf("list interactions by phase: %w", err)
	}
	defer rows.Close()
	return readInteractions(rows)
}

func (s *Store) ListByStatus(status string) ([]Interaction, error) {
	rows, err := s.db.Query(
		`SELECT id, task_id, phase, attempt, run_id, tool, model, log_path, status, error,
			diff, exit_code, duration_ms, quality_json, input_tokens, output_tokens,
			estimated_cost, started_at, finished_at
		 FROM task_interactions WHERE status = ? ORDER BY started_at DESC`,
		status,
	)
	if err != nil {
		return nil, fmt.Errorf("list interactions by status: %w", err)
	}
	defer rows.Close()
	return readInteractions(rows)
}

func (s *Store) IsRunning(taskID *string, phase string) (bool, error) {
	if strings.TrimSpace(phase) == "" {
		return false, fmt.Errorf("phase required")
	}

	query := `SELECT 1 FROM task_interactions WHERE phase = ? AND status = 'running'`
	args := []interface{}{phase}
	if taskID != nil {
		query += ` AND task_id = ?`
		args = append(args, strings.TrimSpace(*taskID))
	}
	query += ` LIMIT 1`

	var one int
	err := s.db.QueryRow(query, args...).Scan(&one)
	if err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, fmt.Errorf("check running interaction: %w", err)
	}
	return true, nil
}

func (s *Store) Get(id string) (*Interaction, error) {
	row := s.db.QueryRow(
		`SELECT id, task_id, phase, attempt, run_id, tool, model, log_path, status, error,
			diff, exit_code, duration_ms, quality_json, input_tokens, output_tokens,
			estimated_cost, started_at, finished_at
		 FROM task_interactions WHERE id = ?`, id,
	)
	in, err := scanInteraction(row.Scan)
	if err != nil {
		return nil, fmt.Errorf("get interaction: %w", err)
	}
	return in, nil
}

func (s *Store) ReadLog(id string) (string, error) {
	r, err := s.OpenLogReader(id)
	if err != nil {
		return "", err
	}
	defer r.Close()
	b, err := io.ReadAll(r)
	if err != nil {
		return "", fmt.Errorf("read interaction log: %w", err)
	}
	return string(b), nil
}

func (s *Store) OpenLogReader(id string) (io.ReadCloser, error) {
	var logPath string
	if err := s.db.QueryRow(`SELECT log_path FROM task_interactions WHERE id = ?`, id).Scan(&logPath); err != nil {
		return nil, fmt.Errorf("get log path: %w", err)
	}
	f, err := os.Open(logPath)
	if err != nil {
		return nil, fmt.Errorf("open log file: %w", err)
	}
	return f, nil
}

func (s *Store) ProjectTotal() (float64, error) {
	var total sql.NullFloat64
	if err := s.db.QueryRow(`SELECT SUM(estimated_cost) FROM task_interactions`).Scan(&total); err != nil {
		return 0, err
	}
	if !total.Valid {
		return 0, nil
	}
	return total.Float64, nil
}

func (s *Store) RunTotal(runID string) (float64, error) {
	var total sql.NullFloat64
	if err := s.db.QueryRow(`SELECT SUM(estimated_cost) FROM task_interactions WHERE run_id = ?`, runID).Scan(&total); err != nil {
		return 0, err
	}
	if !total.Valid {
		return 0, nil
	}
	return total.Float64, nil
}

func (s *Store) RunSummary(runID string) ([]ToolSummary, error) {
	rows, err := s.db.Query(
		`SELECT tool, SUM(input_tokens), SUM(output_tokens), SUM(estimated_cost)
		 FROM task_interactions WHERE run_id = ? GROUP BY tool`,
		runID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return readToolSummaries(rows)
}

func (s *Store) ProjectSummary() ([]ToolSummary, error) {
	rows, err := s.db.Query(
		`SELECT tool, SUM(input_tokens), SUM(output_tokens), SUM(estimated_cost)
		 FROM task_interactions GROUP BY tool`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return readToolSummaries(rows)
}

func (s *Store) MarkStaleAsFailed() error {
	_, err := s.db.Exec(
		`UPDATE task_interactions
		 SET status = 'failed',
		     error = CASE WHEN COALESCE(error, '') = '' THEN ? ELSE error END,
		     finished_at = CASE WHEN finished_at IS NULL THEN ? ELSE finished_at END
		 WHERE status = 'running'`,
		"operation interrupted: server restarted",
		time.Now().UTC(),
	)
	if err != nil {
		return fmt.Errorf("mark stale interactions failed: %w", err)
	}
	return nil
}

// SupersedeReviewPhase marks prior review interactions as failed when a new revise rerun starts.
func (s *Store) SupersedeReviewPhase(taskID string) error {
	_, err := s.db.Exec(
		`UPDATE task_interactions
		 SET status = 'failed',
		     error = CASE WHEN COALESCE(error, '') = '' THEN ? ELSE error END,
		     finished_at = CASE WHEN finished_at IS NULL THEN ? ELSE finished_at END
		 WHERE task_id = ?
		   AND phase = 'review'
		   AND status <> 'failed'`,
		"superseded by revise rerun",
		time.Now().UTC(),
		taskID,
	)
	if err != nil {
		return fmt.Errorf("supersede review interactions: %w", err)
	}
	return nil
}
