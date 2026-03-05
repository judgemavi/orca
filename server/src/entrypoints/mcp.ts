import { join } from 'node:path';
import { bootstrap } from '../bootstrap';
import { initLogger } from '../shared/logger';
import { startMCPServer } from '../mcp/server';

export async function runMCPEntrypoint(repoDir: string) {
  initLogger({ dir: join(repoDir, '.orca', 'logs'), name: 'mcp' });

  const ctx = await bootstrap({ repoDir });

  try {
    await startMCPServer({
      repoDir,
      configStore: ctx.configStore,
      registry: ctx.registry,
      taskStore: ctx.taskStore,
      interactionStore: ctx.interactionStore,
      memoryStore: ctx.memoryStore,
      executor: ctx.executor,
      queue: ctx.queue,
    });
  } finally {
    ctx.database.close();
  }
}
