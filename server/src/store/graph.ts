export function detectCycle(
  taskIDs: string[],
  getDeps: (taskID: string) => string[],
): string[] | null {
  const unvisited = 0;
  const visiting = 1;
  const done = 2;

  const nodes = [...taskIDs].sort((a, b) => a.localeCompare(b));
  const nodeSet = new Set(nodes);
  const state = new Map<string, number>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (node: string): string[] | null => {
    state.set(node, visiting);
    stackIndex.set(node, stack.length);
    stack.push(node);

    const deps = [...getDeps(node)].sort((a, b) => a.localeCompare(b));
    for (const dep of deps) {
      if (!nodeSet.has(dep)) continue;
      const depState = state.get(dep) ?? unvisited;
      if (depState === unvisited) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      } else if (depState === visiting) {
        const start = stackIndex.get(dep) ?? 0;
        return [...stack.slice(start), dep];
      }
    }

    stack.pop();
    stackIndex.delete(node);
    state.set(node, done);
    return null;
  };

  for (const node of nodes) {
    const nodeState = state.get(node) ?? unvisited;
    if (nodeState !== unvisited) continue;
    const cycle = visit(node);
    if (cycle) return cycle;
  }

  return null;
}

export function topoSort(
  taskIDs: string[],
  getDeps: (taskID: string) => string[],
): string[] {
  if (taskIDs.length <= 1) return [...taskIDs];

  const inSet = new Set(taskIDs);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const id of taskIDs) {
    inDegree.set(id, 0);
    for (const dep of getDeps(id)) {
      if (!inSet.has(dep)) continue;
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      const existing = dependents.get(dep) ?? [];
      existing.push(id);
      dependents.set(dep, existing);
    }
  }

  const order = new Map(taskIDs.map((id, idx) => [id, idx]));
  let queue = taskIDs.filter((id) => (inDegree.get(id) ?? 0) === 0);

  const result: string[] = [];
  while (queue.length > 0) {
    queue = [...queue].sort(
      (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
    );
    const next: string[] = [];
    for (const node of queue) {
      result.push(node);
      for (const dep of dependents.get(node) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
        if ((inDegree.get(dep) ?? 0) === 0) {
          next.push(dep);
        }
      }
    }
    queue = next;
  }

  if (result.length < taskIDs.length) {
    for (const id of taskIDs) {
      if (!result.includes(id)) result.push(id);
    }
  }

  return result;
}
