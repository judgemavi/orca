// Package task handles task CRUD and dependency graph.
package task

import "slices"

// DetectCycle runs DFS cycle detection over taskIDs using getDeps.
// It returns the first cycle path encountered, ending with the repeated node.
func DetectCycle(taskIDs []string, getDeps func(taskID string) []string) ([]string, bool) {
	const (
		stateUnvisited = 0
		stateVisiting  = 1
		stateDone      = 2
	)

	nodes := append([]string(nil), taskIDs...)
	slices.Sort(nodes)

	nodeSet := make(map[string]struct{}, len(nodes))
	for _, id := range nodes {
		nodeSet[id] = struct{}{}
	}

	state := make(map[string]int, len(nodes))
	stack := make([]string, 0, len(nodes))
	stackIndex := make(map[string]int, len(nodes))

	var visit func(string) ([]string, bool)
	visit = func(node string) ([]string, bool) {
		state[node] = stateVisiting
		stackIndex[node] = len(stack)
		stack = append(stack, node)

		deps := append([]string(nil), getDeps(node)...)
		slices.Sort(deps)
		for _, dep := range deps {
			if _, ok := nodeSet[dep]; !ok {
				continue
			}
			switch state[dep] {
			case stateUnvisited:
				if cycle, ok := visit(dep); ok {
					return cycle, true
				}
			case stateVisiting:
				start := stackIndex[dep]
				cycle := append([]string{}, stack[start:]...)
				cycle = append(cycle, dep)
				return cycle, true
			}
		}

		stack = stack[:len(stack)-1]
		delete(stackIndex, node)
		state[node] = stateDone
		return nil, false
	}

	for _, node := range nodes {
		if state[node] != stateUnvisited {
			continue
		}
		if cycle, ok := visit(node); ok {
			return cycle, true
		}
	}
	return nil, false
}
