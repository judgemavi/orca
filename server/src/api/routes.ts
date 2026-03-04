import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Executor } from '../executor/executor'
import type { OrcaDrizzleDB } from '../db/connection'
import type { DriverRegistry } from '../driver/registry'
import type { ConfigStore } from '../store/config'
import type { InteractionStore } from '../store/interactions'
import type { MemoryStore } from '../store/memory'
import type { TaskStore } from '../store/tasks'
import type { JobQueue } from '../queue/queue'
import type { EventSink } from './ws'
import { registerConfigHandlers } from './handlers/config'
import { registerCleanupHandlers } from './handlers/cleanup'
import { registerExploreHandlers } from './handlers/explore'
import { registerInteractionHandlers } from './handlers/interactions'
import { registerMemoryHandlers } from './handlers/memory'
import { registerMergeHandlers } from './handlers/merge'
import { registerModelHandlers } from './handlers/models'
import { registerMonitorHandlers } from './handlers/monitor'
import { registerOrchestratorHandlers } from './handlers/orchestrator'
import { registerPlanHandlers } from './handlers/plan'
import { registerQualityHandlers } from './handlers/quality'
import { registerQueueHandlers } from './handlers/queue'

import { registerRunHandlers } from './handlers/run'
import { registerSessionHandlers } from './handlers/sessions'
import { registerStatusHandlers } from './handlers/status'
import { registerTaskPlanHandlers } from './handlers/task-plan'
import { registerTaskWorkflowHandlers } from './handlers/task-workflow'
import { registerTaskHandlers } from './handlers/tasks'

export function buildRoutes(deps: {
  db: OrcaDrizzleDB
  repoDir: string
  taskStore: TaskStore
  configStore: ConfigStore
  interactionStore: InteractionStore
  memoryStore: MemoryStore
  registry: DriverRegistry
  executor: Executor
  eventSink: EventSink
  queue: JobQueue
}) {
  const app = new Hono()
  app.use('*', cors())

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    }),
  )

  const api = app.basePath('/api/v1')
  api.get('/health', (c) => c.json({ data: { status: 'ok' } }))

  registerTaskHandlers(api, {
    taskStore: deps.taskStore,
    interactionStore: deps.interactionStore,
    sink: deps.eventSink,
    repoDir: deps.repoDir,
    queue: deps.queue,
  })
  registerTaskPlanHandlers(api, {
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    interactions: deps.interactionStore,
    memory: deps.memoryStore,
    configStore: deps.configStore,
    registry: deps.registry,
    sink: deps.eventSink,
  })
  registerTaskWorkflowHandlers(api, {
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    interactionStore: deps.interactionStore,
    configStore: deps.configStore,
    registry: deps.registry,
    executor: deps.executor,
    sink: deps.eventSink,
    queue: deps.queue,
  })
  registerRunHandlers(api, {
    executor: deps.executor,
    taskStore: deps.taskStore,
    sink: deps.eventSink,
    queue: deps.queue,
  })
  registerMergeHandlers(api, {
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    configStore: deps.configStore,
    interactionStore: deps.interactionStore,
    memoryStore: deps.memoryStore,
    registry: deps.registry,
    sink: deps.eventSink,
    queue: deps.queue,
  })
registerInteractionHandlers(api, deps.interactionStore)
  registerMemoryHandlers(api, deps.repoDir, deps.memoryStore)
  registerPlanHandlers(api, {
    taskStore: deps.taskStore,
    interactions: deps.interactionStore,
    sink: deps.eventSink,
  })
  registerExploreHandlers(api, deps.repoDir, deps.eventSink, deps.queue)
  registerCleanupHandlers(api, {
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    sink: deps.eventSink,
  })
  registerQualityHandlers(api, deps.interactionStore)
  registerSessionHandlers(api, deps.db)
  registerOrchestratorHandlers(
    api,
    deps.db,
    deps.eventSink,
    deps.configStore,
    deps.repoDir,
    deps.registry,
  )
  registerConfigHandlers(api, deps.configStore)
  registerModelHandlers(api, deps.registry)
  registerStatusHandlers(api, {
    taskStore: deps.taskStore,
    interactions: deps.interactionStore,
    memory: deps.memoryStore,
    repoDir: deps.repoDir,
  })
  registerMonitorHandlers(api, deps.eventSink)
  registerQueueHandlers(api, { queue: deps.queue })
  api.get('/ws', (c) => c.json({ error: 'websocket upgrade required' }, 426))
  api.get('/terminal/:sessionID', (c) =>
    c.json(
      {
        error: `terminal websocket not available for session ${c.req.param('sessionID')}`,
      },
      501,
    ),
  )

  return app
}
