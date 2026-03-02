package diffclass

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type ChangeType string

const (
	ChangeNone    ChangeType = "none"
	ChangeMinor   ChangeType = "minor"
	ChangeMedium  ChangeType = "medium"
	ChangeMajor   ChangeType = "major"
	ChangeDeleted ChangeType = "deleted"
	ChangeRenamed ChangeType = "renamed"
)

type Config struct {
	MinorMaxLines  int
	MediumMaxLines int
}

func DefaultConfig() Config {
	return Config{
		MinorMaxLines:  20,
		MediumMaxLines: 100,
	}
}

type DiffStat struct {
	FilePath     string
	Status       string // "M", "D", "R", "A"
	LinesAdded   int
	LinesRemoved int
	NewPath      string // for renames
}

func (d DiffStat) totalLinesChanged() int {
	// git numstat uses "-" for binary files; we treat unknown magnitudes as major.
	if d.LinesAdded < 0 || d.LinesRemoved < 0 {
		return DefaultConfig().MediumMaxLines + 1
	}
	return d.LinesAdded + d.LinesRemoved
}

func ClassifyDiff(stat DiffStat) ChangeType {
	return ClassifyDiffWithConfig(stat, DefaultConfig())
}

func ClassifyDiffWithConfig(stat DiffStat, cfg Config) ChangeType {
	cfg = normalizeConfig(cfg)

	status := strings.ToUpper(strings.TrimSpace(stat.Status))
	switch {
	case strings.HasPrefix(status, "D"):
		return ChangeDeleted
	case strings.HasPrefix(status, "R"):
		return ChangeRenamed
	}

	total := stat.totalLinesChanged()
	if total < cfg.MinorMaxLines {
		return ChangeMinor
	}
	if total <= cfg.MediumMaxLines {
		return ChangeMedium
	}
	return ChangeMajor
}

func DiffStatsBetween(repoDir, fromCommit, toCommit string) ([]DiffStat, error) {
	repoDir = strings.TrimSpace(repoDir)
	fromCommit = strings.TrimSpace(fromCommit)
	toCommit = strings.TrimSpace(toCommit)
	if repoDir == "" {
		return nil, fmt.Errorf("repo dir required")
	}
	if fromCommit == "" {
		return nil, fmt.Errorf("from commit required")
	}
	if toCommit == "" {
		return nil, fmt.Errorf("to commit required")
	}

	cmd := exec.Command(
		"git",
		"diff",
		"--raw",
		"--numstat",
		"--find-renames",
		"--diff-filter=ADMR",
		fromCommit+".."+toCommit,
	)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("git diff --raw --numstat --diff-filter=ADMR %s..%s: %w: %s", fromCommit, toCommit, err, strings.TrimSpace(string(out)))
	}

	rawStats := make([]DiffStat, 0)
	numstats := make([][2]int, 0)
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, ":") {
			stat, ok := parseRawStat(line)
			if ok {
				rawStats = append(rawStats, stat)
			}
			continue
		}

		numstat, ok := parseNumstat(line)
		if ok {
			numstats = append(numstats, numstat)
		}
	}

	limit := len(rawStats)
	if len(numstats) < limit {
		limit = len(numstats)
	}
	for i := 0; i < limit; i++ {
		rawStats[i].LinesAdded = numstats[i][0]
		rawStats[i].LinesRemoved = numstats[i][1]
	}

	return rawStats, nil
}

func normalizeConfig(cfg Config) Config {
	if cfg.MinorMaxLines <= 0 {
		cfg.MinorMaxLines = 20
	}
	if cfg.MediumMaxLines < cfg.MinorMaxLines {
		cfg.MediumMaxLines = 100
		if cfg.MediumMaxLines < cfg.MinorMaxLines {
			cfg.MediumMaxLines = cfg.MinorMaxLines
		}
	}
	return cfg
}

func parseRawStat(line string) (DiffStat, bool) {
	parts := strings.Split(line, "\t")
	if len(parts) < 2 {
		return DiffStat{}, false
	}
	metaFields := strings.Fields(parts[0])
	if len(metaFields) == 0 {
		return DiffStat{}, false
	}
	statusField := strings.TrimSpace(metaFields[len(metaFields)-1])
	if statusField == "" {
		return DiffStat{}, false
	}
	status := strings.ToUpper(statusField[:1])

	stat := DiffStat{
		Status:       status,
		LinesAdded:   0,
		LinesRemoved: 0,
	}
	if status == "R" {
		if len(parts) < 3 {
			return DiffStat{}, false
		}
		stat.FilePath = normalizePath(parts[1])
		stat.NewPath = normalizePath(parts[2])
		return stat, stat.FilePath != "" && stat.NewPath != ""
	}

	stat.FilePath = normalizePath(parts[len(parts)-1])
	return stat, stat.FilePath != ""
}

func parseNumstat(line string) ([2]int, bool) {
	parts := strings.Split(line, "\t")
	if len(parts) < 3 {
		return [2]int{}, false
	}
	added, ok := parseNumstatValue(parts[0])
	if !ok {
		return [2]int{}, false
	}
	removed, ok := parseNumstatValue(parts[1])
	if !ok {
		return [2]int{}, false
	}
	return [2]int{added, removed}, true
}

func parseNumstatValue(raw string) (int, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "-" {
		return -1, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, false
	}
	return n, true
}

func normalizePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	return filepath.ToSlash(path)
}
