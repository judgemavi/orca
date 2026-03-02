// retrieval.go contains multi-layer memory retrieval and sibling-task context selection.
package memory

import (
	"fmt"
	"sort"
	"strings"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/task"
)

type Retriever struct {
	memory       *Store
	taskStore    *task.Store
	interactions *interaction.Store
	repoDir      string
	syncer       *Syncer
}

type RetrievalResult struct {
	Summary        *Entry            `json:"summary,omitempty"`
	FileMatches    []*Entry          `json:"file_matches,omitempty"`
	Relevant       []*Entry          `json:"relevant,omitempty"`
	SiblingTasks   []SiblingTaskInfo `json:"sibling_tasks,omitempty"`
	StaleRefreshed int               `json:"stale_refreshed"`
}

type SiblingTaskInfo struct {
	TaskID      string   `json:"task_id"`
	Title       string   `json:"title"`
	Status      string   `json:"status"`
	PlanSummary string   `json:"plan_summary"`
	FilePaths   []string `json:"file_paths,omitempty"`
}

type RetrievalOpts struct {
	TaskTitle       string
	TaskDescription string
	FilePaths       []string
	ExcludeTaskID   string
	SummaryBudget   int
	FileBudget      int
	FTSBudget       int
	SiblingBudget   int
}

func NewRetriever(memoryStore *Store, taskStore *task.Store, interactions *interaction.Store, repoDir string) *Retriever {
	return &Retriever{
		memory:       memoryStore,
		taskStore:    taskStore,
		interactions: interactions,
		repoDir:      strings.TrimSpace(repoDir),
	}
}

func (r *Retriever) WithSyncer(syncer *Syncer) *Retriever {
	r.syncer = syncer
	return r
}

func (r *Retriever) Retrieve(opts RetrievalOpts) (*RetrievalResult, error) {
	result := &RetrievalResult{
		FileMatches:  []*Entry{},
		Relevant:     []*Entry{},
		SiblingTasks: []SiblingTaskInfo{},
	}
	if r.memory == nil {
		return result, nil
	}

	summaryBudget := budgetOrDefault(opts.SummaryBudget, 1)
	fileBudget := budgetOrDefault(opts.FileBudget, 5)
	ftsBudget := budgetOrDefault(opts.FTSBudget, 5)
	siblingBudget := budgetOrDefault(opts.SiblingBudget, 3)

	seen := map[string]struct{}{}
	refreshed := map[string]struct{}{}

	if summaryBudget > 0 {
		summaries, err := r.memory.List(ListOpts{Tag: "project-summary"})
		if err != nil {
			return nil, err
		}
		for _, entry := range summaries {
			includeEntry, refreshCount, includeErr := r.prepareEntry(entry, refreshed)
			if includeErr != nil {
				return nil, includeErr
			}
			result.StaleRefreshed += refreshCount
			if includeEntry == nil {
				continue
			}
			result.Summary = includeEntry
			seen[includeEntry.ID] = struct{}{}
			break
		}
	}

	if fileBudget > 0 && len(opts.FilePaths) > 0 {
		fileMatches, err := r.memory.FindByFilePaths(opts.FilePaths)
		if err != nil {
			return nil, err
		}
		for _, entry := range fileMatches {
			if len(result.FileMatches) >= fileBudget {
				break
			}
			if _, ok := seen[entry.ID]; ok {
				continue
			}
			includeEntry, refreshCount, includeErr := r.prepareEntry(entry, refreshed)
			if includeErr != nil {
				return nil, includeErr
			}
			result.StaleRefreshed += refreshCount
			if includeEntry == nil {
				continue
			}
			result.FileMatches = append(result.FileMatches, includeEntry)
			seen[includeEntry.ID] = struct{}{}
		}
	}

	if ftsBudget > 0 {
		query := strings.TrimSpace(opts.TaskTitle + "\n" + opts.TaskDescription)
		semantic, err := r.memory.Search(query, ftsBudget*2)
		if err != nil {
			return nil, err
		}
		for _, entry := range semantic {
			if len(result.Relevant) >= ftsBudget {
				break
			}
			if _, ok := seen[entry.ID]; ok {
				continue
			}
			includeEntry, refreshCount, includeErr := r.prepareEntry(entry, refreshed)
			if includeErr != nil {
				return nil, includeErr
			}
			result.StaleRefreshed += refreshCount
			if includeEntry == nil {
				continue
			}
			result.Relevant = append(result.Relevant, includeEntry)
			seen[includeEntry.ID] = struct{}{}
		}
	}

	if siblingBudget > 0 {
		siblings, err := r.findSiblingTasks(opts, siblingBudget)
		if err != nil {
			return nil, err
		}
		result.SiblingTasks = siblings
	}

	return result, nil
}

func (r *Retriever) prepareEntry(entry *Entry, refreshed map[string]struct{}) (*Entry, int, error) {
	if entry == nil {
		return nil, 0, nil
	}
	if !entry.Stale || r.syncer == nil {
		return entry, 0, nil
	}
	if _, ok := refreshed[entry.ID]; ok {
		reloaded, err := r.memory.Get(entry.ID)
		if err != nil {
			return entry, 0, nil
		}
		return reloaded, 0, nil
	}
	refreshResult, err := r.syncer.Refresh(entry.ID)
	if err != nil {
		return entry, 0, nil
	}
	refreshed[entry.ID] = struct{}{}
	reloaded, reloadErr := r.memory.Get(entry.ID)
	if reloadErr != nil {
		return entry, refreshResult.Updated, nil
	}
	return reloaded, refreshResult.Updated, nil
}

func (r *Retriever) BuildPromptSection(result *RetrievalResult) string {
	if result == nil {
		return ""
	}
	blocks := make([]string, 0, 3)
	if result.Summary != nil && strings.TrimSpace(result.Summary.Content) != "" {
		blocks = append(blocks, "## Project Context\n"+strings.TrimSpace(result.Summary.Content))
	}

	knowledge := make([]*Entry, 0, len(result.FileMatches)+len(result.Relevant))
	seen := make(map[string]struct{})
	for _, entry := range result.FileMatches {
		if entry == nil {
			continue
		}
		if _, ok := seen[entry.ID]; ok {
			continue
		}
		seen[entry.ID] = struct{}{}
		knowledge = append(knowledge, entry)
	}
	for _, entry := range result.Relevant {
		if entry == nil {
			continue
		}
		if _, ok := seen[entry.ID]; ok {
			continue
		}
		seen[entry.ID] = struct{}{}
		knowledge = append(knowledge, entry)
	}
	if len(knowledge) > 0 {
		lines := []string{"## Relevant Knowledge", ""}
		for i, entry := range knowledge {
			lines = append(lines, fmt.Sprintf("%d. %s", i+1, strings.TrimSpace(entry.Content)))
			lines = append(lines, fmt.Sprintf("   - source: %s", strings.TrimSpace(entry.SourceType)))
			lines = append(lines, fmt.Sprintf("   - confidence: %.2f", entry.Confidence))
			if len(entry.FilePaths) > 0 {
				lines = append(lines, fmt.Sprintf("   - files: %s", strings.Join(entry.FilePaths, ", ")))
			}
			if entry.Stale {
				lines = append(lines, "   - stale: true")
			}
		}
		blocks = append(blocks, strings.Join(lines, "\n"))
	}

	if len(result.SiblingTasks) > 0 {
		lines := []string{"## Related Active Tasks", ""}
		for i, sibling := range result.SiblingTasks {
			lines = append(lines, fmt.Sprintf("%d. %s (status: %s)", i+1, strings.TrimSpace(sibling.Title), strings.TrimSpace(sibling.Status)))
			if strings.TrimSpace(sibling.PlanSummary) != "" {
				lines = append(lines, fmt.Sprintf("   Plan: %s", strings.TrimSpace(sibling.PlanSummary)))
			}
			if len(sibling.FilePaths) > 0 {
				lines = append(lines, fmt.Sprintf("   Files: %s", strings.Join(sibling.FilePaths, ", ")))
			}
		}
		blocks = append(blocks, strings.Join(lines, "\n"))
	}

	return strings.TrimSpace(strings.Join(blocks, "\n\n"))
}

func (r *Retriever) findSiblingTasks(opts RetrievalOpts, budget int) ([]SiblingTaskInfo, error) {
	if r.memory == nil || r.memory.db == nil {
		return []SiblingTaskInfo{}, nil
	}
	if budget <= 0 {
		return []SiblingTaskInfo{}, nil
	}

	query := strings.TrimSpace(opts.TaskTitle + "\n" + opts.TaskDescription)
	fts := buildFTSQuery(query)
	args := []interface{}{}
	sql := strings.Builder{}
	sql.WriteString(`SELECT t.id, t.title, t.status, COALESCE(t.plan, '')
		FROM tasks t`)
	if fts != "" {
		sql.WriteString(`
		JOIN tasks_fts tf ON tf.id = t.id`)
	}
	sql.WriteString(`
		WHERE t.status IN ('planned','running','review','approved')`)
	if exclude := strings.TrimSpace(opts.ExcludeTaskID); exclude != "" {
		sql.WriteString(` AND t.id <> ?`)
		args = append(args, exclude)
	}
	if fts != "" {
		sql.WriteString(` AND tf MATCH ?`)
		args = append(args, fts)
	}
	sql.WriteString(` ORDER BY t.updated_at DESC LIMIT ?`)
	args = append(args, budget*3)

	rows, err := r.memory.db.Query(sql.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	candidates := make([]SiblingTaskInfo, 0)
	for rows.Next() {
		var info SiblingTaskInfo
		if err := rows.Scan(&info.TaskID, &info.Title, &info.Status, &info.PlanSummary); err != nil {
			return nil, err
		}
		paths, err := r.loadTaskFilePaths(info.TaskID)
		if err != nil {
			return nil, err
		}
		info.FilePaths = paths
		info.PlanSummary = firstPlanLines(info.PlanSummary, 5)
		candidates = append(candidates, info)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		leftOverlap := overlapCount(candidates[i].FilePaths, opts.FilePaths)
		rightOverlap := overlapCount(candidates[j].FilePaths, opts.FilePaths)
		if leftOverlap == rightOverlap {
			return candidates[i].TaskID < candidates[j].TaskID
		}
		return leftOverlap > rightOverlap
	})

	if len(candidates) > budget {
		candidates = candidates[:budget]
	}
	return candidates, nil
}

func (r *Retriever) loadTaskFilePaths(taskID string) ([]string, error) {
	rows, err := r.memory.db.Query(
		`SELECT file_path
		 FROM task_file_associations
		 WHERE task_id = ?
		 ORDER BY file_path`,
		taskID,
	)
	if err != nil {
		return nil, err
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

func overlapCount(left, right []string) int {
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	seen := make(map[string]struct{}, len(right))
	for _, path := range right {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		seen[path] = struct{}{}
	}
	count := 0
	for _, path := range left {
		if _, ok := seen[strings.TrimSpace(path)]; ok {
			count++
		}
	}
	return count
}

func firstPlanLines(plan string, maxLines int) string {
	plan = strings.TrimSpace(plan)
	if plan == "" || maxLines <= 0 {
		return ""
	}
	lines := strings.Split(plan, "\n")
	if len(lines) > maxLines {
		lines = lines[:maxLines]
	}
	for i, line := range lines {
		lines[i] = strings.TrimSpace(line)
	}
	return strings.TrimSpace(strings.Join(lines, " "))
}

func budgetOrDefault(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}
