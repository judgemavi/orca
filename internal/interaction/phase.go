package interaction

import "github.com/jasjeetmavi/orca/internal/worker"

const (
	PhasePlan      = "plan"
	PhaseEvaluate  = "evaluate"
	PhaseBreakdown = "breakdown"
	PhaseRun       = "run"
	PhaseRevise    = "revise"
	PhaseReview    = "review"
	PhaseMerge     = "merge"
	PhaseExplore   = "explore"
)

type RunWithTrackingOption func(*runWithTrackingConfig)

type runWithTrackingConfig struct {
	onBegin  func(*Writer)
	afterRun func(*worker.Result, error)
	finishFn func(*worker.Result, error) (string, []FinishOption)
}

func WithOnBegin(fn func(*Writer)) RunWithTrackingOption {
	return func(cfg *runWithTrackingConfig) {
		cfg.onBegin = fn
	}
}

func WithAfterRun(fn func(*worker.Result, error)) RunWithTrackingOption {
	return func(cfg *runWithTrackingConfig) {
		cfg.afterRun = fn
	}
}

func WithFinishFn(fn func(*worker.Result, error) (string, []FinishOption)) RunWithTrackingOption {
	return func(cfg *runWithTrackingConfig) {
		cfg.finishFn = fn
	}
}

// RunWithTracking handles interaction Begin/output-capture/Finish boilerplate.
func RunWithTracking(
	store *Store,
	taskRef *string,
	phase string,
	toolName string,
	adapter *worker.Adapter,
	fn func() (*worker.Result, error),
	opts ...RunWithTrackingOption,
) (*worker.Result, error) {
	cfg := runWithTrackingConfig{
		finishFn: func(result *worker.Result, runErr error) (string, []FinishOption) {
			status := "completed"
			finishOpts := []FinishOption{}
			if result != nil {
				finishOpts = append(finishOpts, WithCost(result.InputTokens, result.OutputTokens, result.TotalCost))
			}
			if runErr != nil {
				status = "failed"
				finishOpts = append(finishOpts, WithError(runErr.Error()))
			}
			return status, finishOpts
		},
	}
	for _, opt := range opts {
		opt(&cfg)
	}

	var writer *Writer
	if store != nil {
		w, beginErr := store.Begin(taskRef, phase, toolName)
		if beginErr == nil {
			writer = w
			if cfg.onBegin != nil {
				cfg.onBegin(w)
			}
		}
	}

	var (
		outputCh   chan worker.OutputLine
		outputDone chan struct{}
	)
	if writer != nil {
		outputCh = make(chan worker.OutputLine, 256)
		outputDone = make(chan struct{})
		adapter.SetOutputChan(outputCh)
		go func() {
			defer close(outputDone)
			for line := range outputCh {
				if line.Stream == "raw" {
					_ = writer.WriteString(line.Line + "\n")
				}
			}
		}()
	}

	result, runErr := fn()

	if outputCh != nil {
		close(outputCh)
		<-outputDone
	}

	if cfg.afterRun != nil {
		cfg.afterRun(result, runErr)
	}

	if writer != nil {
		status, finishOpts := cfg.finishFn(result, runErr)
		_ = store.Finish(writer.ID(), status, finishOpts...)
		_ = writer.Close()
	}

	return result, runErr
}
