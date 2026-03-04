import { Hono } from 'hono'
import type { EventSink } from '../ws'
import type { DriverRegistry } from '../../driver/registry'
import { runRetro } from '../../domain/retro'
import type { ConfigStore } from '../../store/config'
import type { InteractionStore } from '../../store/interactions'
import type { MemoryStore } from '../../store/memory'
import type { TaskStore } from '../../store/tasks'
import { asyncOp } from './async-op'
import { broadcast, parseBody, safeErrorMessage } from './utils'

interface RetroBody {
  tool?: string
  model?: string
}

export function registerRetroHandlers(
  app: Hono,
  deps: {
    repoDir: string
    taskStore: TaskStore
    interactions: InteractionStore
    memoryStore: MemoryStore
    configStore: ConfigStore
    registry?: DriverRegistry
    sink: EventSink
  },
) {
  app.post('/tasks/:id/retro', async (c) => {
    const taskID = c.req.param('id')
    const task = await deps.taskStore.get(taskID)
    if (!task) return c.json({ error: 'task not found' }, 404)

    if (task.status !== 'approved' && task.status !== 'merged') {
      return c.json({ error: `task ${taskID} is ${task.status}; retro requires approved/merged` }, 400)
    }

    const body = await parseBody<RetroBody>(c.req)

    asyncOp(deps.sink, {
      completed: {
        name: 'retro.completed',
        payload: ({ result }) => ({
          taskId: taskID,
          interactionId: result.interactionId,
          entriesCreated: result.entriesCreated,
        }),
      },
      failed: {
        name: 'retro.failed',
        payload: ({ error }) => ({ taskId: taskID, error: safeErrorMessage(error) }),
      },
      run: async () => {
        const config = await deps.configStore.load()
        broadcast(deps.sink, 'retro.started', { taskId: taskID })

        const result = await runRetro(taskID, {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          interactionStore: deps.interactions,
          memoryStore: deps.memoryStore,
          config,
          registry: deps.registry,
          toolOverride: body.tool ?? '',
          modelOverride: body.model ?? '',
        })

        return {
          interactionId: result.interactionId,
          entriesCreated: result.memoryEntries.length,
        }
      },
    })

    return c.json({ data: { taskId: taskID, status: 'started' } }, 202)
  })
}
