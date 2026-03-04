import type { MemoryStore } from '../store/memory'

export async function queryMemory(memory: MemoryStore, q: string, limit: number) {
  const results = await memory.search(q, limit)
  return Promise.all(results.map(async (entry) => ({
    entry,
    usedByTasks: await memory.findUsedByTasks(entry.id),
  })))
}

export async function getMemoryDetail(memory: MemoryStore, id: string) {
  const entry = await memory.get(id)
  if (!entry) {
    throw new Error(`memory entry not found: ${id}`)
  }

  return {
    entry,
    usedByTasks: await memory.findUsedByTasks(entry.id),
    supersedes: await memory.findSupersededIDs(entry.id),
  }
}

export async function memorySyncSnapshot(memory: MemoryStore) {
  const stale = await memory.findStaleEntries()
  const health = await memory.buildHealthSummary()
  return {
    lastCommit: '',
    newCommit: '',
    commitCount: 0,
    affectedFiles: [],
    flaggedEntries: stale.length,
    staleEntries: stale.length,
    supersededCount: 0,
    classifications: {},
    contextUpdated: false,
    contextStale: health.staleCount > 0,
  }
}
