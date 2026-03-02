package driver

import (
	"sort"
	"strings"
)

var registry = map[string]Driver{
	"claude": &Claude{},
	"codex":  &Codex{},
}

func Get(name string) (Driver, bool) {
	d, ok := registry[strings.ToLower(name)]
	return d, ok
}

func Available() []string {
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
