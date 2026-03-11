import { join } from 'node:path';
import { buildRoutes } from '../api/routes';
import { startHTTPServer } from '../api/server';
import { createEventSink } from '../api/ws';
import { bootstrap } from '../bootstrap';
import {
  failInFlightForShutdown,
  runStartupRecovery,
} from '../domain/recovery';
import { registerJobHandlers } from '../queue/handlers';
import { clearDaemonPid, writeDaemonPid } from '../queue/lock';
import { JobProcessor } from '../queue/processor';
import { initLogger, log } from '../shared/logger';
import { killAllTracked, trackedCount } from '../shared/process-registry';

export async function runServeEntrypoint(repoDir: string, port: number) {
  initLogger({ dir: join(repoDir, '.orca', 'logs'), name: 'server' });

  const eventSink = createEventSink();
  const ctx = await bootstrap({ repoDir, eventSink });

  const processor = new JobProcessor({
    queue: ctx.queue,
    maxParallel: ctx.config.workers.maxParallel,
    sink: eventSink,
  });

  registerJobHandlers(processor, { ...ctx, sink: eventSink });

  await ctx.workflowStore.initSchemas(repoDir);

  await runStartupRecovery(
    ctx.db,
    ctx.interactionStore,
    (event, data) => {
      log.info(event, (data as Record<string, unknown>) ?? {});
    },
    ctx.queue,
  );

  processor.start();
  writeDaemonPid(repoDir);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      log.warn('forced exit');
      console.log('forced exit');
      process.exit(1);
    }
    shuttingDown = true;
    log.info('shutdown signal received');
    console.log('shutting down...');

    ctx.executor.stopAllTasks();
    await processor.stop();

    const numProcs = trackedCount();
    if (numProcs > 0) {
      log.info(`killing ${numProcs} child process(es)`);
      await killAllTracked('SIGTERM');
    }

    await failInFlightForShutdown(
      ctx.db,
      ctx.interactionStore,
      (event, data) => {
        log.info(event, (data as Record<string, unknown>) ?? {});
      },
    );
    ctx.workflowStore.cleanup();
    clearDaemonPid(repoDir);
    ctx.database.close();
    console.log('shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const app = buildRoutes({
    ...ctx,
    db: ctx.database.db,
    eventSink,
  });

  startHTTPServer(app, port, {
    db: ctx.db,
    repoDir,
    registry: ctx.registry,
  });
  log.info(`server listening on :${port}`);
  console.log(`orca server listening on :${port}`);
}
