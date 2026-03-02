// Package task handles task CRUD and dependency graph.
package task

import (
	"slices"
)

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

// TopoSort returns taskIDs ordered so that dependencies come before dependents.
// Deps outside the input set are treated as already satisfied.
// Within each topo level, input order is preserved.
// If a cycle exists, remaining nodes are appended at the end.
func TopoSort(taskIDs []string, getDeps func(string) []string) []string {
	if len(taskIDs) <= 1 {
		return append([]string(nil), taskIDs...)
	}

	inSet := make(map[string]struct{}, len(taskIDs))
	for _, id := range taskIDs {
		inSet[id] = struct{}{}
	}

	// Build in-degree map and reverse adjacency (only for edges within the set).
	inDegree := make(map[string]int, len(taskIDs))
	dependents := make(map[string][]string, len(taskIDs)) // dep -> list of nodes that depend on it
	for _, id := range taskIDs {
		if _, ok := inDegree[id]; !ok {
			inDegree[id] = 0
		}
		for _, dep := range getDeps(id) {
			if _, ok := inSet[dep]; !ok {
				continue // outside input set — already satisfied
			}
			inDegree[id]++
			dependents[dep] = append(dependents[dep], id)
		}
	}

	// Preserve input order index for stable tiebreaking.
	orderIdx := make(map[string]int, len(taskIDs))
	for i, id := range taskIDs {
		orderIdx[id] = i
	}

	// Seed queue with zero in-degree nodes in input order.
	queue := make([]string, 0, len(taskIDs))
	for _, id := range taskIDs {
		if inDegree[id] == 0 {
			queue = append(queue, id)
		}
	}

	result := make([]string, 0, len(taskIDs))
	for len(queue) > 0 {
		// Sort current level by input order for stable output.
		slices.SortFunc(queue, func(a, b string) int {
			return orderIdx[a] - orderIdx[b]
		})

		// Process entire level.
		nextQueue := make([]string, 0)
		for _, node := range queue {
			result = append(result, node)
			for _, dep := range dependents[node] {
				inDegree[dep]--
				if inDegree[dep] == 0 {
					nextQueue = append(nextQueue, dep)
				}
			}
		}
		queue = nextQueue
	}

	// Cycle fallback: append any remaining nodes in input order.
	if len(result) < len(taskIDs) {
		for _, id := range taskIDs {
			found := false
			for _, r := range result {
				if r == id {
					found = true
					break
				}
			}
			if !found {
				result = append(result, id)
			}
		}
	}

	return result
}
