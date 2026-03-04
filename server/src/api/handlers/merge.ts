import { Hono } from 'hono'
import type { DriverRegistry } from '../../driver/registry'
import type { ConfigStore } from '../../store/config'
import type { InteractionStore } from '../../store/interactions'
import type { MemoryStore } from '../../store/memory'
import type { TaskStore } from '../../store/tasks'
import type { JobQueue } from '../../queue/queue'
import type { EventSink } from '../ws'
import { JOB_PRIORITIES } from '../../types'
import { mergeAllApproved } from '../../workflows/merge'
import { asyncOp } from './async-op'
import { broadcast, parseBody } from './utils'

interface MergeBody {
  mode?: string
}

export function registerMergeHandlers(
  app: Hono,
  deps: {
    repoDir: string
    taskStore: TaskStore
    configStore: ConfigStore
    interactionStore: InteractionStore
    memoryStore: MemoryStore
    registry?: DriverRegistry
    sink: EventSink
    queue: JobQueue
  },
) {
  app.post('/tasks/:id/merge', async (c) => {
    const taskID = c.req.param('id')
    const task = await deps.taskStore.get(taskID)
    if (!task) return c.json({ error: 'task not found' }, 404)

    await parseBody<MergeBody>(c.req)

    const { id: jobId } = await deps.queue.enqueue({
      type: 'merge',
      taskId: taskID,
      priority: JOB_PRIORITIES.merge,
    })

    return c.json({ data: { jobId, taskId: taskID, status: 'queued' } }, 202)
  })

  app.post('/merge', async (c) => {
    await parseBody<Record<string, unknown>>(c.req)
    const { operationId } = asyncOp(deps.sink, {
      idPrefix: 'merge',
      run: async (operationId) => {
        broadcast(deps.sink, 'merge.started', { operationId, mode: 'batch' })

        try {
          const merged = await mergeAllApproved({
            repoDir: deps.repoDir,
            taskStore: deps.taskStore,
            configStore: deps.configStore,
            interactions: deps.interactionStore,
            memoryStore: deps.memoryStore,
            registry: deps.registry,
            sink: deps.sink,
          })

          for (const result of merged.results) {
            if (result.status === 'merged') {
              broadcast(deps.sink, 'task.updated', { id: result.taskId, status: 'merged' })
              broadcast(deps.sink, 'merge.progress', { taskId: result.taskId, status: 'merged' })
            } else {
              broadcast(deps.sink, 'task.updated', { id: result.taskId, status: 'failed' })
              broadcast(deps.sink, 'merge.progress', {
                taskId: result.taskId,
                status: 'failed',
                error: result.error || 'merge failed',
              })
            }
          }

          if (merged.failed.length > 0) {
            broadcast(deps.sink, 'merge.failed', {
              operationId,
              error: `${merged.failed.length} task(s) failed to merge`,
              merged: merged.merged,
              failed: merged.failed,
              results: merged.results,
            })
            return
          }

          broadcast(deps.sink, 'merge.completed', {
            operationId,
            merged: merged.merged,
            failed: merged.failed,
            results: merged.results,
          })
        } catch (error) {
          broadcast(deps.sink, 'merge.failed', {
            operationId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })

    return c.json({ data: { operationId } }, 202)
  })
}
