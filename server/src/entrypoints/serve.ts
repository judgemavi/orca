import { join } from 'node:path';
import { DbChangePoller } from '../api/db-poller';
import { buildRoutes } from '../api/routes';
import { startHTTPServer } from '../api/server';
import { createEventSink } from '../api/ws';
import { bootstrap } from '../bootstrap';
import {
  failInFlightForShutdown,
  runStartupRecovery,
} from '../domain/recovery';
import { registerJobHandlers } from '../queue/handlers';
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

  registerJobHandlers(processor, {
    repoDir,
    configStore: ctx.configStore,
    registry: ctx.registry,
    taskStore: ctx.taskStore,
    interactionStore: ctx.interactionStore,
    memoryStore: ctx.memoryStore,
    executor: ctx.executor,
    sink: eventSink,
    queue: ctx.queue,
  });

  await runStartupRecovery(
    ctx.taskStore,
    ctx.interactionStore,
    (event, data) => {
      log.info(event, data as Record<string, unknown> ?? {});
    },
    ctx.queue,
  );

  processor.start();

  const poller = new DbChangePoller(ctx.database.db, eventSink);
  poller.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      log.warn('forced exit');
      process.exit(1);
    }
    shuttingDown = true;
    log.info('shutdown signal received');

    ctx.executor.stopAllTasks();
    poller.stop();
    await processor.stop();

    const numProcs = trackedCount();
    if (numProcs > 0) {
      log.info(`killing ${numProcs} child process(es)`);
      await killAllTracked('SIGTERM');
    }

    await failInFlightForShutdown(
      ctx.taskStore,
      ctx.interactionStore,
      (event, data) => {
        log.info(event, data as Record<string, unknown> ?? {});
      },
    );
    ctx.database.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const app = buildRoutes({
    db: ctx.database.db,
    repoDir,
    taskStore: ctx.taskStore,
    configStore: ctx.configStore,
    interactionStore: ctx.interactionStore,
    memoryStore: ctx.memoryStore,
    registry: ctx.registry,
    executor: ctx.executor,
    eventSink,
    queue: ctx.queue,
  });

  startHTTPServer(app, port, {
    configStore: ctx.configStore,
    repoDir,
    registry: ctx.registry,
  });
  log.info(`server listening on :${port}`);
}
