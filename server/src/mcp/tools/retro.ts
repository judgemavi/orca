import type { Tool } from '../types'
import { z } from 'zod'
import type { DriverRegistry } from '../../driver/registry'
import { runRetro } from '../../domain/retro'
import type { ConfigStore } from '../../store/config'
import type { InteractionStore } from '../../store/interactions'
import type { MemoryStore } from '../../store/memory'
import type { TaskStore } from '../../store/tasks'
import { defineTool } from '../define-tool'

const tasksRetroSchema = z.object({
  taskId: z.preprocess(
    (value) => value ?? '',
    z.coerce.string().trim().min(1, 'taskId is required'),
  ),
  tool: z.preprocess(
    (value) => (value === undefined ? undefined : value ?? ''),
    z.coerce.string().optional(),
  ),
  model: z.preprocess(
    (value) => (value === undefined ? undefined : value ?? ''),
    z.coerce.string().optional(),
  ),
})

export function retroTools(deps: {
  repoDir: string
  taskStore: TaskStore
  interactions: InteractionStore
  memoryStore: MemoryStore
  configStore: ConfigStore
  registry?: DriverRegistry
}): Tool[] {
  return [
    defineTool({
      name: 'tasks_retro',
      description: 'Generate retrospective summary for task',
      schema: tasksRetroSchema,
      handler: async (input) => {
        const taskID = input.taskId
        const task = await deps.taskStore.get(taskID)
        if (!task) throw new Error(`task not found: ${taskID}`)
        if (task.status !== 'approved' && task.status !== 'merged') {
          throw new Error('task must be approved or merged')
        }

        const config = await deps.configStore.load()
        const result = await runRetro(taskID, {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          interactionStore: deps.interactions,
          memoryStore: deps.memoryStore,
          config,
          registry: deps.registry,
          toolOverride: input.tool ?? '',
          modelOverride: input.model ?? '',
        })

        return {
          taskId: taskID,
          retro: result.summary,
          entriesCreated: result.memoryEntries.length,
          interactionId: result.interactionId,
        }
      },
    }),
  ]
}
