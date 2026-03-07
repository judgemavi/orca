import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { OrcaDrizzleDB } from '../db/connection';
import type { EmbeddingRegistry } from '../embedding/registry';
import type { Executor } from '../executor/executor';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
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
import { qualityRoutes } from './handlers/quality';
import { queueRoutes } from './handlers/queue';
import { runRoutes } from './handlers/run';
import { sessionRoutes } from './handlers/sessions';
import { statusRoutes } from './handlers/status';
import { taskPlanRoutes } from './handlers/task-plan';
import { taskWorkflowRoutes } from './handlers/task-workflow';
import { taskRoutes } from './handlers/tasks';
import type { EventSink } from './ws';

interface RouteDeps {
  db: OrcaDrizzleDB;
  repoDir: string;
  taskStore: TaskStore;
  configStore: ConfigStore;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  registry: ToolPluginRegistry;
  embeddingRegistry: EmbeddingRegistry;
  executor: Executor;
  eventSink: EventSink;
  queue: JobQueue;
}

function taskGroup(deps: RouteDeps) {
  return new Hono()
    .route(
      '/',
      taskRoutes({
        taskStore: deps.taskStore,
        interactionStore: deps.interactionStore,
        configStore: deps.configStore,
        sink: deps.eventSink,
        repoDir: deps.repoDir,
        queue: deps.queue,
      }),
    )
    .route(
      '/',
      taskPlanRoutes({
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        interactions: deps.interactionStore,
        memory: deps.memoryStore,
        configStore: deps.configStore,
        registry: deps.registry,
        sink: deps.eventSink,
        queue: deps.queue,
      }),
    )
    .route(
      '/',
      taskWorkflowRoutes({
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        interactionStore: deps.interactionStore,
        configStore: deps.configStore,
        registry: deps.registry,
        executor: deps.executor,
        sink: deps.eventSink,
        queue: deps.queue,
      }),
    )
    .route(
      '/',
      runRoutes({
        executor: deps.executor,
        taskStore: deps.taskStore,
        sink: deps.eventSink,
        queue: deps.queue,
      }),
    )
    .route('/', interactionRoutes(deps.interactionStore))
    .route('/', qualityRoutes(deps.interactionStore));
}

function dataGroup(deps: RouteDeps) {
  return new Hono()
    .route(
      '/',
      mergeRoutes({
        taskStore: deps.taskStore,
        queue: deps.queue,
      }),
    )
    .route('/', memoryRoutes(deps.repoDir, deps.memoryStore))
    .route('/', exploreRoutes(deps.repoDir, deps.queue))
    .route(
      '/',
      cleanupRoutes({
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        sink: deps.eventSink,
      }),
    );
}

function infraGroup(deps: RouteDeps) {
  return new Hono()
    .route('/', sessionRoutes(deps.db))
    .route('/', orchestratorRoutes(deps.eventSink))
    .route(
      '/',
      configRoutes(
        deps.configStore,
        deps.embeddingRegistry,
        deps.memoryStore,
        deps.db,
      ),
    )
    .route('/', modelRoutes(deps.registry))
    .route(
      '/',
      statusRoutes({
        taskStore: deps.taskStore,
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
