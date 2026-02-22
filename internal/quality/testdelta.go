package quality

import (
	"os/exec"
	"regexp"
	"time"
)

// Snapshot holds the result of running validation commands at a point in time.
type Snapshot struct {
	Results []CommandResult
	TakenAt time.Time
}

type CommandResult struct {
	Command  string
	ExitCode int
	Output   string
}

// Delta compares two snapshots and reports what changed.
type Delta struct {
	NewFailures    []string // commands that passed before but fail now
	NewPasses      []string // commands that failed before but pass now
	Unchanged      []string // commands with same exit code
	TestCountDelta int      // net change in test count (if parseable)
}

var (
	genericTestsRe = regexp.MustCompile(`(?i)\b(\d+)\s+tests?\b`)
	goOKLineRe     = regexp.MustCompile(`(?m)^ok\s+\S+\s+[\d.]+s(?:\s|$)`)
	goPassLineRe   = regexp.MustCompile(`(?m)^--- PASS:`)
)

// TakeSnapshot runs all validation commands in a directory and captures results.
func TakeSnapshot(dir string, commands []string) (*Snapshot, error) {
	results := make([]CommandResult, 0, len(commands))

	for _, command := range commands {
		cmd := exec.Command("sh", "-c", command)
		cmd.Dir = dir

		output, err := cmd.CombinedOutput()
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				return nil, err
			}
		}

		results = append(results, CommandResult{
			Command:  command,
			ExitCode: exitCode,
			Output:   string(output),
		})
	}

	return &Snapshot{
		Results: results,
		TakenAt: time.Now(),
	}, nil
}

// ComputeDelta compares before and after snapshots.
func ComputeDelta(before, after *Snapshot) *Delta {
	delta := &Delta{}
	if before == nil || after == nil {
		delta.TestCountDelta = -1
		return delta
	}

	beforeByCommand := make(map[string]CommandResult, len(before.Results))
	for _, result := range before.Results {
		beforeByCommand[result.Command] = result
	}

	beforeCount := 0
	afterCount := 0
	hasCountData := true

	for _, afterResult := range after.Results {
		beforeResult, ok := beforeByCommand[afterResult.Command]
		if !ok {
			continue
		}

		if beforeResult.ExitCode == 0 && afterResult.ExitCode != 0 {
			delta.NewFailures = append(delta.NewFailures, afterResult.Command)
		} else if beforeResult.ExitCode != 0 && afterResult.ExitCode == 0 {
			delta.NewPasses = append(delta.NewPasses, afterResult.Command)
		} else {
			delta.Unchanged = append(delta.Unchanged, afterResult.Command)
		}

		beforeParsed := ParseTestCount(beforeResult.Output)
		afterParsed := ParseTestCount(afterResult.Output)
		if beforeParsed == -1 || afterParsed == -1 {
			hasCountData = false
			continue
		}

		beforeCount += beforeParsed
		afterCount += afterParsed
	}

	if hasCountData {
		delta.TestCountDelta = afterCount - beforeCount
	} else {
		delta.TestCountDelta = -1
	}

	return delta
}

// ParseTestCount attempts to extract test count from output.
// Supports: "ok ... N tests", "PASS: N tests", "--- PASS:", go test output patterns.
// Returns -1 if unparseable.
func ParseTestCount(output string) int {
	okLines := goOKLineRe.FindAllStringIndex(output, -1)
	if len(okLines) > 0 {
		return len(okLines)
	}

	passLines := goPassLineRe.FindAllStringIndex(output, -1)
	if len(passLines) > 0 {
		return len(passLines)
	}

	matches := genericTestsRe.FindStringSubmatch(output)
	if len(matches) == 2 {
		count := 0
		for i := 0; i < len(matches[1]); i++ {
			count = (count * 10) + int(matches[1][i]-'0')
		}
		return count
	}

	return -1
}
