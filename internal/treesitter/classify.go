package treesitter

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

type ChangeType string

const (
	ChangeNone       ChangeType = "none"
	ChangeBody       ChangeType = "body"
	ChangeStructural ChangeType = "structural"
	ChangeDeleted    ChangeType = "deleted"
)

type ChangeResult struct {
	Type            ChangeType `json:"type"`
	AffectedSymbols []string   `json:"affected_symbols,omitempty"`
}

// ClassifyChange compares old and new content for a file and classifies impact.
// This is deterministic and language-aware using lightweight syntax heuristics.
func ClassifyChange(filename string, oldContent, newContent []byte) ChangeResult {
	if len(newContent) == 0 && len(oldContent) > 0 {
		return ChangeResult{Type: ChangeDeleted}
	}

	oldNormalized := normalizeForNone(filename, oldContent)
	newNormalized := normalizeForNone(filename, newContent)
	if bytes.Equal(oldNormalized, newNormalized) {
		return ChangeResult{Type: ChangeNone}
	}

	lang := detectLanguage(filename)
	if lang == "" {
		return ChangeResult{Type: ChangeBody}
	}

	oldStructural, oldSymbols := extractStructuralSignature(lang, oldContent)
	newStructural, newSymbols := extractStructuralSignature(lang, newContent)
	if oldStructural != newStructural {
		return ChangeResult{
			Type:            ChangeStructural,
			AffectedSymbols: diffSymbols(oldSymbols, newSymbols),
		}
	}

	return ChangeResult{Type: ChangeBody}
}

// ClassifyFileChange compares file content between two commits.
func ClassifyFileChange(repoDir, filePath, oldCommit, newCommit string) (ChangeResult, error) {
	oldContent, oldExists, err := gitShowFile(repoDir, oldCommit, filePath)
	if err != nil {
		return ChangeResult{}, err
	}
	newContent, newExists, err := gitShowFile(repoDir, newCommit, filePath)
	if err != nil {
		return ChangeResult{}, err
	}

	if !oldExists && !newExists {
		return ChangeResult{Type: ChangeNone}, nil
	}
	if !newExists && oldExists {
		return ChangeResult{Type: ChangeDeleted}, nil
	}
	if !oldExists && newExists {
		// New files are treated as structural if declarations were introduced.
		res := ClassifyChange(filePath, nil, newContent)
		if res.Type == ChangeNone {
			res.Type = ChangeBody
		}
		return res, nil
	}

	return ClassifyChange(filePath, oldContent, newContent), nil
}

func gitShowFile(repoDir, commit, filePath string) ([]byte, bool, error) {
	commit = strings.TrimSpace(commit)
	filePath = strings.TrimSpace(filepath.ToSlash(filePath))
	if commit == "" || filePath == "" {
		return nil, false, nil
	}

	arg := fmt.Sprintf("%s:%s", commit, filePath)
	cmd := exec.Command("git", "show", arg)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err == nil {
		return out, true, nil
	}
	text := strings.ToLower(string(out))
	if strings.Contains(text, "does not exist in") ||
		strings.Contains(text, "path '"+strings.ToLower(filePath)+"' exists on disk, but not in") {
		return nil, false, nil
	}
	return nil, false, fmt.Errorf("git show %s: %w: %s", arg, err, strings.TrimSpace(string(out)))
}

func detectLanguage(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".go":
		return "go"
	case ".ts", ".tsx":
		return "ts"
	case ".js", ".jsx", ".mjs", ".cjs":
		return "js"
	case ".sql":
		return "sql"
	default:
		return ""
	}
}

func normalizeForNone(filename string, content []byte) []byte {
	lang := detectLanguage(filename)
	lines := strings.Split(string(content), "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		switch lang {
		case "go", "ts", "js":
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "/*") || strings.HasPrefix(trimmed, "*") || strings.HasPrefix(trimmed, "*/") {
				continue
			}
		case "sql":
			if strings.HasPrefix(trimmed, "--") {
				continue
			}
		}
		out = append(out, strings.Join(strings.Fields(trimmed), ""))
	}
	return []byte(strings.Join(out, "\n"))
}

func extractStructuralSignature(lang string, content []byte) (string, []string) {
	lines := strings.Split(string(content), "\n")
	structural := make([]string, 0, len(lines))
	symbols := make([]string, 0, 16)

	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}

		switch lang {
		case "go":
			if matchesAny(line, goStructuralPatterns) {
				structural = append(structural, canonicalizeGoStructural(line))
				if name := extractFirstMatch(line, goSymbolPatterns...); name != "" {
					symbols = append(symbols, name)
				}
			}
		case "ts", "js":
			if matchesAny(line, tsStructuralPatterns) {
				structural = append(structural, canonicalizeTSStructural(line))
				if name := extractFirstMatch(line, tsSymbolPatterns...); name != "" {
					symbols = append(symbols, name)
				}
			}
		case "sql":
			if matchesAny(strings.ToLower(line), sqlStructuralPatterns) {
				structural = append(structural, strings.Join(strings.Fields(strings.ToLower(line)), " "))
				if name := extractFirstMatch(strings.ToLower(line), sqlSymbolPatterns...); name != "" {
					symbols = append(symbols, name)
				}
			}
		}
	}

	symbols = uniqueSorted(symbols)
	structural = uniqueSorted(structural)
	return strings.Join(structural, "\n"), symbols
}

func matchesAny(line string, patterns []*regexp.Regexp) bool {
	for _, pattern := range patterns {
		if pattern.MatchString(line) {
			return true
		}
	}
	return false
}

func extractFirstMatch(line string, patterns ...*regexp.Regexp) string {
	for _, pattern := range patterns {
		matches := pattern.FindStringSubmatch(line)
		if len(matches) > 1 {
			return strings.TrimSpace(matches[1])
		}
	}
	return ""
}

func uniqueSorted(items []string) []string {
	if len(items) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	slices.Sort(out)
	return out
}

func diffSymbols(oldSymbols, newSymbols []string) []string {
	oldSet := make(map[string]struct{}, len(oldSymbols))
	for _, sym := range oldSymbols {
		oldSet[sym] = struct{}{}
	}
	newSet := make(map[string]struct{}, len(newSymbols))
	for _, sym := range newSymbols {
		newSet[sym] = struct{}{}
	}

	diff := make([]string, 0, len(oldSymbols)+len(newSymbols))
	for sym := range oldSet {
		if _, ok := newSet[sym]; !ok {
			diff = append(diff, sym)
		}
	}
	for sym := range newSet {
		if _, ok := oldSet[sym]; !ok {
			diff = append(diff, sym)
		}
	}
	slices.Sort(diff)
	return diff
}

func canonicalizeGoStructural(line string) string {
	line = strings.TrimSpace(line)
	switch {
	case strings.HasPrefix(line, "func "):
		if idx := strings.Index(line, "{"); idx >= 0 {
			line = strings.TrimSpace(line[:idx])
		}
	case strings.HasPrefix(line, "const "), strings.HasPrefix(line, "var "):
		if idx := strings.Index(line, "="); idx >= 0 {
			line = strings.TrimSpace(line[:idx])
		}
	}
	return strings.Join(strings.Fields(line), " ")
}

func canonicalizeTSStructural(line string) string {
	line = strings.TrimSpace(line)
	switch {
	case strings.Contains(line, "=>"):
		if idx := strings.Index(line, "=>"); idx >= 0 {
			line = strings.TrimSpace(line[:idx])
		}
	case strings.HasPrefix(line, "function "), strings.HasPrefix(line, "export function "):
		if idx := strings.Index(line, "{"); idx >= 0 {
			line = strings.TrimSpace(line[:idx])
		}
	case strings.HasPrefix(line, "const "), strings.HasPrefix(line, "export const "):
		if idx := strings.Index(line, "="); idx >= 0 {
			line = strings.TrimSpace(line[:idx])
		}
	}
	return strings.Join(strings.Fields(line), " ")
}

var (
	goStructuralPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^package\s+\w+`),
		regexp.MustCompile(`^import\s+`),
		regexp.MustCompile(`^type\s+\w+`),
		regexp.MustCompile(`^func\s+(\([^)]*\)\s*)?\w+\s*\(`),
		regexp.MustCompile(`^const\s+\w+`),
		regexp.MustCompile(`^var\s+\w+`),
	}
	goSymbolPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^type\s+(\w+)`),
		regexp.MustCompile(`^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(`),
		regexp.MustCompile(`^(?:const|var)\s+(\w+)`),
	}

	tsStructuralPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^(?:import|export)\s+`),
		regexp.MustCompile(`^(?:interface|type|class)\s+\w+`),
		regexp.MustCompile(`^(?:export\s+)?function\s+\w+\s*\(`),
		regexp.MustCompile(`^(?:export\s+)?const\s+\w+\s*=\s*\(`),
	}
	tsSymbolPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^(?:interface|type|class)\s+(\w+)`),
		regexp.MustCompile(`^(?:export\s+)?function\s+(\w+)\s*\(`),
		regexp.MustCompile(`^(?:export\s+)?const\s+(\w+)`),
	}

	sqlStructuralPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^(create|alter|drop)\s+(table|view|index|function|trigger)\b`),
		regexp.MustCompile(`^with\s+\w+\s+as\s*\(`),
	}
	sqlSymbolPatterns = []*regexp.Regexp{
		regexp.MustCompile(`^(?:create|alter|drop)\s+(?:table|view|index|function|trigger)\s+([a-zA-Z0-9_\.]+)`),
	}
)
