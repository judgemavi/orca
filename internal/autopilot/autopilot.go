// Package autopilot runs the full explore→plan→sprint→review→integrate loop autonomously.
package autopilot

import (
	"fmt"
	"log"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/decompose"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/integrator"
	"github.com/jasjeetmavi/pod/internal/review"
	"github.com/jasjeetmavi/pod/internal/sprint"
	"github.com/jasjeetmavi/pod/internal/state"
	"github.com/jasjeetmavi/pod/internal/task"
)

// EventType identifies the kind of autopilot event.
type EventType int

const (
	EventExploreComplete   EventType = iota
	EventPlanProposed                // tasks proposed, awaiting approval
	EventSprintComplete              // sprint finished, showing results
	EventReviewComplete              // review results ready
	EventIntegrateComplete           // merge results ready
	EventEscalation                  // autopilot needs help
	EventProgress                    // status update
)

// Event is emitted by the autopilot to report progress or request input.
type Event struct {
	Type    EventType
	Message string
	Data    interface{} // type-specific payload
}

// Callback is called when autopilot needs user input.
// Returns true to continue, false to abort.
type Callback func(event Event) bool

// Options configures supervisor behavior.
type Options struct {
	MaxSprints    int
	PauseOnReview bool
}

// Supervisor orchestrates the autonomous loop.
type Supervisor struct {
	db       *state.DB
	cfg      *config.Config
	store    *task.Store
	planner  *sprint.Planner
	executor *sprint.Executor
	repoDir  string

	goal        string
	maxSprints  int
	pauseReview bool
	retryCount  map[string]int // taskID → failure count
}

// New creates a Supervisor.
func New(db *state.DB, cfg *config.Config, planner *sprint.Planner,
	executor *sprint.Executor, repoDir string, opts Options) *Supervisor {
	return &Supervisor{
		db:          db,
		cfg:         cfg,
		store:       task.NewStore(db),
		planner:     planner,
		executor:    executor,
		repoDir:     repoDir,
		maxSprints:  opts.MaxSprints,
		pauseReview: opts.PauseOnReview,
		retryCount:  make(map[string]int),
	}
}

// Executor returns the underlying executor for external cancel support.
func (s *Supervisor) Executor() *sprint.Executor { return s.executor }

// Run executes the full autonomous loop for the given goal.
func (s *Supervisor) Run(goal string, cb Callback) error {
	s.goal = goal

	// a. EXPLORE
	if explore.LoadContext(s.repoDir) == "" {
		cb(Event{Type: EventProgress, Message: "Exploring codebase..."})
		toolCfg, err := s.resolveToolConfig("")
		if err != nil {
			return fmt.Errorf("resolve tool for explore: %w", err)
		}
		explorer := explore.New(toolCfg, s.repoDir)
		outPath, err := explorer.Run()
		if err != nil {
			return fmt.Errorf("explore: %w", err)
		}
		if !cb(Event{Type: EventExploreComplete, Message: fmt.Sprintf("Context written to %s", outPath)}) {
			return fmt.Errorf("aborted after explore")
		}
	}

	// b. DECOMPOSE
	cb(Event{Type: EventProgress, Message: fmt.Sprintf("Decomposing: %s", goal)})
	toolCfg, err := s.resolveToolConfig("")
	if err != nil {
		return fmt.Errorf("resolve tool for decompose: %w", err)
	}
	d := decompose.New(toolCfg, s.repoDir)
	proposed, err := d.Run(goal)
	if err != nil {
		return fmt.Errorf("decompose: %w", err)
	}

	if !cb(Event{Type: EventPlanProposed, Message: fmt.Sprintf("Proposed %d tasks", len(proposed)), Data: proposed}) {
		return fmt.Errorf("aborted after plan proposal")
	}

	// Create tasks in DB with deps.
	createdIDs := make([]string, len(proposed))
	for i, pt := range proposed {
		created, err := s.store.Create(pt.Title, pt.Description, "", pt.SuggestedTool)
		if err != nil {
			return fmt.Errorf("create task %d: %w", i+1, err)
		}
		createdIDs[i] = created.ID
	}
	for i, pt := range proposed {
		for _, depIdx := range pt.DependsOnIndices {
			if depIdx >= 0 && depIdx < len(createdIDs) {
				if err := s.store.AddDependency(createdIDs[i], createdIDs[depIdx]); err != nil {
					return fmt.Errorf("add dep for task %d: %w", i+1, err)
				}
			}
		}
	}

	// c-d. SPRINT LOOP + FINISH
	return s.RunSprintLoop(cb)
}

// RunSprintLoop executes the sprint/review/integrate loop and emits completion progress.
func (s *Supervisor) RunSprintLoop(cb Callback) error {
	escalateThreshold := s.cfg.Autopilot.EscalateAfterRetries
	if escalateThreshold <= 0 {
		escalateThreshold = 2
	}

	sprintNum := 0
	for {
		if s.maxSprints > 0 && sprintNum >= s.maxSprints {
			cb(Event{Type: EventProgress, Message: fmt.Sprintf("Max sprints (%d) reached", s.maxSprints)})
			break
		}

		// i. Check for ready tasks.
		ready, err := s.store.GetReady()
		if err != nil {
			return fmt.Errorf("get ready tasks: %w", err)
		}
		if len(ready) == 0 {
			break
		}

		sprintNum++

		// ii. Plan sprint.
		sp, err := s.planner.Plan(s.cfg.Workers.MaxParallel)
		if err != nil {
			return fmt.Errorf("plan sprint %d: %w", sprintNum, err)
		}
		cb(Event{Type: EventProgress, Message: fmt.Sprintf("Sprint %d planned: %d tasks", sprintNum, len(sp.TaskIDs))})

		// iii. Execute sprint.
		results, err := s.executor.Run(sp)
		if err != nil {
			return fmt.Errorf("execute sprint %d: %w", sprintNum, err)
		}

		succeeded, failed := countResults(results)
		cb(Event{Type: EventSprintComplete, Message: fmt.Sprintf("Sprint %d: %d succeeded, %d failed", sprintNum, succeeded, failed), Data: results})

		// iv. Handle failures.
		abort := false
		for _, r := range results {
			if r.Status != "failed" {
				continue
			}
			s.RecordFailure(r.TaskID)
			if s.ShouldEscalate(r.TaskID, escalateThreshold) {
				if !cb(Event{Type: EventEscalation, Message: fmt.Sprintf("Task %s failed %d times", r.TaskID[:8], s.retryCount[r.TaskID])}) {
					abort = true
					break
				}
			} else {
				// Reset to pending for retry in next sprint.
				if err := s.resetFailedTask(r.TaskID); err != nil {
					log.Printf("reset failed task %s: %v", r.TaskID, err)
				}
			}
		}
		if abort {
			return fmt.Errorf("aborted after escalation")
		}

		// v. Review — skip if only one tool configured (same tool reviewing its own code is low value).
		var reviewResults []review.ReviewResult
		if len(s.cfg.Tools) > 1 {
			reviewResults, err = s.runReview(results, sp.ID)
			if err != nil {
				log.Printf("review error: %v", err)
			} else if len(reviewResults) > 0 {
				approved, rejected := countReviewResults(reviewResults)
				if !cb(Event{Type: EventReviewComplete, Message: fmt.Sprintf("Review: %d approved, %d rejected", approved, rejected), Data: reviewResults}) {
					return fmt.Errorf("aborted after review")
				}
				if rejected > 0 && s.pauseReview {
					if !cb(Event{Type: EventEscalation, Message: fmt.Sprintf("%d tasks rejected by reviewer", rejected)}) {
						return fmt.Errorf("aborted after review rejection")
					}
				}
			}
		}

		// vi. Integrate completed+approved tasks.
		taskIDs := s.collectMergeableTaskIDs(results, reviewResults)
		if len(taskIDs) > 0 {
			ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
			ig.SetRerunConfig(s.cfg.Project.WorktreeDir, func(taskID string) (config.ToolConfig, error) {
				return s.resolveToolConfigForTask(taskID)
			})
			merged, failedIDs, _ := ig.MergeBatch(taskIDs)
			cb(Event{Type: EventIntegrateComplete, Message: fmt.Sprintf("Integrated: %d merged, %d failed", len(merged), len(failedIDs))})
		}

		// Cleanup worktrees.
		s.executor.Cleanup(sp)
	}

	// d. FINISH
	cb(Event{Type: EventProgress, Message: "Autopilot complete"})
	return nil
}

// runReview runs automated review on completed tasks that have diffs.
func (s *Supervisor) runReview(results []sprint.TaskResult, sprintID string) ([]review.ReviewResult, error) {
	// Pick a review tool different from the task tool if possible.
	var reviewToolCfg config.ToolConfig
	for name, tc := range s.cfg.Tools {
		_ = name
		reviewToolCfg = tc
		break
	}
	// Try to find a tool different from the first one.
	firstName := ""
	for name := range s.cfg.Tools {
		if firstName == "" {
			firstName = name
			continue
		}
		reviewToolCfg = s.cfg.Tools[name]
		break
	}

	var inputs []review.ReviewInput
	for _, r := range results {
		if r.Status != "completed" || r.Diff == "" {
			continue
		}
		t, err := s.planner.GetTask(r.TaskID)
		if err != nil {
			continue
		}
		inputs = append(inputs, review.ReviewInput{
			TaskID:      r.TaskID,
			Title:       t.Title,
			Description: t.Description,
			Diff:        r.Diff,
		})
	}

	if len(inputs) == 0 {
		return nil, nil
	}

	reviewer := review.New(reviewToolCfg, s.repoDir)
	return reviewer.ReviewBatch(inputs)
}

// collectMergeableTaskIDs returns task IDs that completed and (if reviewed) were approved.
func (s *Supervisor) collectMergeableTaskIDs(results []sprint.TaskResult, reviewResults []review.ReviewResult) []string {
	rejected := make(map[string]bool)
	for _, r := range reviewResults {
		if !r.Approved {
			rejected[r.TaskID] = true
		}
	}

	var ids []string
	for _, r := range results {
		if r.Status == "completed" && !rejected[r.TaskID] {
			ids = append(ids, r.TaskID)
		}
	}
	return ids
}

// resolveToolConfig returns the ToolConfig for the named tool, or the first available.
func (s *Supervisor) resolveToolConfig(name string) (config.ToolConfig, error) {
	if name != "" {
		tc, ok := s.cfg.Tools[name]
		if !ok {
			return config.ToolConfig{}, fmt.Errorf("tool %q not found in config", name)
		}
		return tc, nil
	}
	for _, tc := range s.cfg.Tools {
		return tc, nil
	}
	return config.ToolConfig{}, fmt.Errorf("no tools configured")
}

// resolveToolConfigForTask resolves the tool config for a specific task.
func (s *Supervisor) resolveToolConfigForTask(taskID string) (config.ToolConfig, error) {
	t, err := s.store.Get(taskID)
	if err != nil {
		return config.ToolConfig{}, err
	}
	return s.resolveToolConfig(t.AssignedTool)
}

// resetFailedTask resets a task to pending with no sprint association.
func (s *Supervisor) resetFailedTask(taskID string) error {
	return s.store.Update(taskID, map[string]interface{}{
		"status":    "pending",
		"sprint_id": nil,
	})
}

func countResults(results []sprint.TaskResult) (succeeded, failed int) {
	for _, r := range results {
		if r.Status == "completed" {
			succeeded++
		} else {
			failed++
		}
	}
	return
}

func countReviewResults(results []review.ReviewResult) (approved, rejected int) {
	for _, r := range results {
		if r.Approved {
			approved++
		} else {
			rejected++
		}
	}
	return
}
