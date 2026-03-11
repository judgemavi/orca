import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { OrcaDrizzleDB } from '../db/connection';
import type { EmbeddingRegistry } from '../embedding/registry';
import type { AppDeps } from '../types/deps';
import { cleanupRoutes } from './handlers/cleanup';
import { configRoutes } from './handlers/config';
import { eventRoutes } from './handlers/events';
import { exploreRoutes } from './handlers/explore';
import { interactionRoutes } from './handlers/interactions';
import { memoryRoutes } from './handlers/memory';
import { mergeRoutes } from './handlers/merge';
import { modelRoutes } from './handlers/models';
import { monitorRoutes } from './handlers/monitor';
import { orchestratorRoutes } from './handlers/orchestrator';
import { queueRoutes } from './handlers/queue';
import { runRoutes } from './handlers/run';
import { statusRoutes } from './handlers/status';
import { taskWorkflowRoutes } from './handlers/task-workflow';
import { taskRoutes } from './handlers/tasks';
import type { EventSink } from './ws';

type RouteDeps = AppDeps & {
  db: OrcaDrizzleDB;
  embeddingRegistry: EmbeddingRegistry;
  eventSink: EventSink;
};

function taskGroup(deps: RouteDeps) {
  return new Hono()
    .route(
      '/',
      taskRoutes({
        db: deps.db,
        sink: deps.eventSink,
        interactionStore: deps.interactionStore,
        repoDir: deps.repoDir,
        queue: deps.queue,
        workflowStore: deps.workflowStore,
      }),
    )
    .route(
      '/',
      taskWorkflowRoutes({
        repoDir: deps.repoDir,
        db: deps.db,
        interactionStore: deps.interactionStore,
        sink: deps.eventSink,
        queue: deps.queue,
        workflowStore: deps.workflowStore,
      }),
    )
    .route(
      '/',
      runRoutes({
        executor: deps.executor,
        db: deps.db,
        sink: deps.eventSink,
        interactionStore: deps.interactionStore,
        queue: deps.queue,
        workflowStore: deps.workflowStore,
      }),
    )
    .route(
      '/',
      interactionRoutes({
        interactions: deps.interactionStore,
        repoDir: deps.repoDir,
      }),
    );
}

function dataGroup(deps: RouteDeps) {
  return new Hono()
    .route(
      '/',
      mergeRoutes({
        db: deps.db,
        sink: deps.eventSink,
        queue: deps.queue,
      }),
    )
    .route('/', memoryRoutes(deps.repoDir, deps.memoryStore))
    .route('/', exploreRoutes(deps.repoDir, deps.queue, deps.db))
    .route(
      '/',
      cleanupRoutes({
        repoDir: deps.repoDir,
        db: deps.db,
        sink: deps.eventSink,
      }),
    );
}

function infraGroup(deps: RouteDeps) {
  return new Hono()
    .route('/', orchestratorRoutes(deps.eventSink))
    .route(
      '/',
      configRoutes(
        deps.db,
        deps.embeddingRegistry,
        deps.memoryStore,
        deps.eventSink,
      ),
    )
    .route('/', modelRoutes(deps.registry))
    .route(
      '/',
      statusRoutes({
        db: deps.db,
        interactions: deps.interactionStore,
        memory: deps.memoryStore,
        repoDir: deps.repoDir,
      }),
    )
    .route('/', monitorRoutes(deps.eventSink))
    .route('/', queueRoutes({ queue: deps.queue }))
    .route('/', eventRoutes(deps.eventSink));
}

function createApi(deps: RouteDeps) {
  return new Hono()
    .get('/health', (c) => c.json({ status: 'ok' }))
    .route('/', taskGroup(deps))
    .route('/', dataGroup(deps))
    .route('/', infraGroup(deps));
}

export type AppType = ReturnType<typeof createApi>;

export function buildRoutes(deps: RouteDeps) {
  const app = new Hono();
  app.use('*', cors());

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    }),
  );

  app.route('/api/v1', createApi(deps));

  return app;
}
