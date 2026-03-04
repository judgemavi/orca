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

export async function runServeEntrypoint(repoDir: string, port: number) {
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
  });

  await runStartupRecovery(
    ctx.taskStore,
    ctx.interactionStore,
    (event, data) => {
      console.error(`[${event}]`, data ?? {});
    },
    ctx.queue,
  );

  processor.start();

  const poller = new DbChangePoller(
    ctx.database.db,
    eventSink,
    ctx.configStore,
  );
  poller.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    console.error('[shutdown] signal received, stopping…');
    ctx.executor.stopAllTasks();
    poller.stop();
    await processor.stop();
    await failInFlightForShutdown(
      ctx.taskStore,
      ctx.interactionStore,
      (event, data) => {
        console.error(`[${event}]`, data ?? {});
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

  startHTTPServer(app, port, eventSink);
  console.log(`orca server listening on :${port}`);
}
