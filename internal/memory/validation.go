// validation.go contains shared category/source-type validation helpers.
package memory

import "strings"

var validCategories = []string{
	"pattern",
	"pitfall",
	"preference",
	"convention",
	"architecture",
	"dependency",
}

var validSourceTypes = []string{
	"retro",
	"explore",
}

func IsValidCategory(category string) bool {
	category = strings.TrimSpace(strings.ToLower(category))
	for _, valid := range validCategories {
		if category == valid {
			return true
		}
	}
	return false
}

func IsValidSourceType(sourceType string) bool {
	sourceType = strings.TrimSpace(strings.ToLower(sourceType))
	for _, valid := range validSourceTypes {
		if sourceType == valid {
			return true
		}
	}
	return false
}

func ValidCategories() []string {
	out := make([]string, len(validCategories))
	copy(out, validCategories)
	return out
}

func ValidSourceTypes() []string {
	out := make([]string, len(validSourceTypes))
	copy(out, validSourceTypes)
	return out
}
