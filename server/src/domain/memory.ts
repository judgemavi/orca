import type { MemoryStore } from '../store/memory';

export async function queryMemory(
  memory: MemoryStore,
  q: string,
  limit: number,
) {
  const results = await memory.searchWithScores(q, limit);
  return Promise.all(
    results.map(async ({ entry, score }) => ({
      entry,
      score,
      usedByTasks: await memory.findUsedByTasks(entry.id),
    })),
  );
}

export async function getMemoryDetail(memory: MemoryStore, id: string) {
  const entry = await memory.get(id);
  if (!entry) {
    throw new Error(`memory entry not found: ${id}`);
  }

  return {
    entry,
    usedByTasks: await memory.findUsedByTasks(entry.id),
    supersedes: await memory.findSupersededIDs(entry.id),
  };
}
