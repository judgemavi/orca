package llm

import (
	"encoding/json"
	"errors"
	"strings"
)

// ErrNoJSON indicates that no JSON object or array was found in the input.
var ErrNoJSON = errors.New("no json found")

// ExtractJSON finds the first JSON object or array in raw LLM output and
// unmarshals it into dst.
func ExtractJSON(raw string, dst interface{}) error {
	found, err := TryExtractJSON(raw, dst)
	if !found {
		return ErrNoJSON
	}
	return err
}

// TryExtractJSON is like ExtractJSON but returns whether a JSON structure was found.
func TryExtractJSON(raw string, dst interface{}) (bool, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return false, nil
	}

	candidates := []string{trimmed}
	if unfenced := stripMarkdownFence(trimmed); unfenced != trimmed {
		candidates = append([]string{unfenced}, candidates...)
	}

	for _, candidate := range candidates {
		start, end, ok := firstJSONSpan(candidate)
		if !ok {
			continue
		}
		return true, json.Unmarshal([]byte(candidate[start:end]), dst)
	}

	return false, nil
}

func stripMarkdownFence(s string) string {
	lines := strings.Split(s, "\n")
	if len(lines) < 3 {
		return s
	}

	if !strings.HasPrefix(strings.TrimSpace(lines[0]), "```") {
		return s
	}
	if strings.TrimSpace(lines[len(lines)-1]) != "```" {
		return s
	}

	return strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
}

func firstJSONSpan(s string) (int, int, bool) {
	start := -1
	var opener rune
	var closer rune
	for i, r := range s {
		if r == '{' || r == '[' {
			start = i
			opener = r
			if opener == '{' {
				closer = '}'
			} else {
				closer = ']'
			}
			break
		}
	}
	if start == -1 {
		return 0, 0, false
	}

	depth := 0
	inString := false
	escape := false
	for i, r := range s[start:] {
		if inString {
			if escape {
				escape = false
				continue
			}
			if r == '\\' {
				escape = true
				continue
			}
			if r == '"' {
				inString = false
			}
			continue
		}

		if r == '"' {
			inString = true
			continue
		}

		if r == opener {
			depth++
		}
		if r == closer {
			depth--
			if depth == 0 {
				return start, start + i + len(string(r)), true
			}
		}
	}

	return 0, 0, false
}
