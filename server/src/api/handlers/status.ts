import { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import { getMemorySyncStatus } from '../../domain/memory-sync';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import * as taskStore from '../../store/tasks';

export function statusRoutes(deps: {
  db: OrcaDrizzleDB;
  interactions: InteractionStore;
  memory: MemoryStore;
  repoDir: string;
}) {
  return new Hono().get('/status', async (c) => {
    const tasks = await taskStore.listTasks(deps.db);

    const pending = tasks.filter((task) => task.status === 'pending').length;
    const inProgress = tasks.filter((task) => task.status === 'running').length;
    const failed = tasks.filter((task) => task.status === 'failed').length;
    const completed = tasks.filter(
      (task) =>
        task.status === 'merged' ||
        task.status === 'approved' ||
        task.status === 'review' ||
        task.status === 'broken_down',
    ).length;

    const contextPath = `${deps.repoDir}/.orca/explore_context.md`;
    const contextFile = Bun.file(contextPath);
    const contextExists = await contextFile.exists();

    const memoryHealth = await deps.memory.buildHealthSummary();
    const sync = await getMemorySyncStatus(deps.repoDir, deps.memory);

    return c.json({
      project: 'orca',
      totalTasks: tasks.length,
      pending,
      inProgress: inProgress,
      completed,
      failed,
      contextExists: contextExists,
      contextStale: memoryHealth.staleCount > 0,
      contextAgeMinutes: 0,
      runningOperations: (await deps.interactions.listByStatus('running'))
        .length,
      lastSyncedCommit: sync.lastSyncedCommit,
      currentCommit: sync.currentCommit,
      syncNeeded: sync.syncNeeded,
      commitsBehind: sync.commitsBehind,
      memoryTotal: memoryHealth.totalEntries,
      memoryStaleCount: memoryHealth.staleCount,
    });
  });
}
