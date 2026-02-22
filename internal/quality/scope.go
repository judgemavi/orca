package quality

import (
	"strconv"
	"strings"
)

// ScopeAnalysis captures scope creep signals for a task diff.
type ScopeAnalysis struct {
	TaskID       string
	FilesChanged int
	LinesChanged int
	Flags        []string // human-readable flags like "15 files changed (expected <5 for task size)"
	Excessive    bool     // true if any flag indicates scope creep
}

// AnalyzeScope checks a task's diff for scope creep indicators.
func AnalyzeScope(taskID, title, diff string) *ScopeAnalysis {
	files := make(map[string]struct{})
	topDirs := make(map[string]struct{})
	added := 0
	removed := 0
	testFiles := 0

	for _, line := range strings.Split(diff, "\n") {
		if strings.HasPrefix(line, "diff --git a/") {
			path := parseDiffPath(line)
			if path == "" {
				continue
			}

			if _, ok := files[path]; !ok {
				files[path] = struct{}{}
				topDirs[topLevelDir(path)] = struct{}{}
				if isTestFile(path) {
					testFiles++
				}
			}
			continue
		}

		if strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---") {
			continue
		}
		if strings.HasPrefix(line, "+") {
			added++
			continue
		}
		if strings.HasPrefix(line, "-") {
			removed++
		}
	}

	fileCount := len(files)
	linesChanged := added + removed
	threshold := fileThreshold(title)
	flags := make([]string, 0)
	isRefactor := containsAnyFold(title, "refactor", "rename")

	if fileCount > threshold {
		flags = append(flags, formatFileCountFlag(fileCount, threshold))
	}

	if !isRefactor && linesChanged > 500 {
		flags = append(flags, "high line churn for non-refactor task (>500 changed lines)")
	}

	nonTestFiles := fileCount - testFiles
	if testFiles == 0 && nonTestFiles > 3 {
		flags = append(flags, "no tests added for multi-file change")
	}

	if len(topDirs) > 3 {
		flags = append(flags, "changes span many directories")
	}

	return &ScopeAnalysis{
		TaskID:       taskID,
		FilesChanged: fileCount,
		LinesChanged: linesChanged,
		Flags:        flags,
		Excessive:    len(flags) > 0,
	}
}

func parseDiffPath(line string) string {
	parts := strings.Fields(line)
	if len(parts) < 4 {
		return ""
	}
	path := parts[2]
	if !strings.HasPrefix(path, "a/") {
		return ""
	}
	return strings.TrimPrefix(path, "a/")
}

func topLevelDir(path string) string {
	idx := strings.Index(path, "/")
	if idx == -1 {
		return "(root)"
	}
	return path[:idx]
}

func isTestFile(path string) bool {
	base := path
	if idx := strings.LastIndex(path, "/"); idx != -1 {
		base = path[idx+1:]
	}

	if strings.HasSuffix(base, "_test.go") {
		return true
	}
	if strings.HasSuffix(base, ".test.ts") {
		return true
	}
	return strings.Contains(base, ".spec.")
}

func fileThreshold(title string) int {
	if containsAnyFold(title, "refactor", "rename") {
		return 20
	}
	if containsAnyFold(title, "fix", "patch", "typo") {
		return 5
	}
	if containsAnyFold(title, "add", "create", "implement") {
		return 10
	}
	return 8
}

func containsAnyFold(s string, keywords ...string) bool {
	s = strings.ToLower(s)
	for _, kw := range keywords {
		if strings.Contains(s, kw) {
			return true
		}
	}
	return false
}

func formatFileCountFlag(filesChanged, threshold int) string {
	return strings.Join([]string{
		strconv.Itoa(filesChanged),
		" files changed (expected <",
		strconv.Itoa(threshold),
		" for task size)",
	}, "")
}
