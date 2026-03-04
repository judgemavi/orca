import { bootstrap } from '../bootstrap';
import { startMCPServer } from '../mcp/server';

export async function runMCPEntrypoint(repoDir: string) {
  // MCP mode: stdout is reserved for protocol — redirect all logging to stderr
  const stderrLog = (...args: unknown[]) => console.error(...args);
  console.log = stderrLog;
  console.info = stderrLog;
  console.warn = stderrLog;

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
