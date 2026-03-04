import type { Command } from 'commander'
import type { InteractionStore } from '../../store/interactions'
import type { MemoryStore } from '../../store/memory'
import type { TaskStore } from '../../store/tasks'
import { printJSON } from '../format'

export function registerStatusCommand(
  program: Command,
  deps: {
    taskStore: TaskStore
    interactions: InteractionStore
    memory: MemoryStore
  },
) {
  program.command('status').action(async () => {
    const tasks = await deps.taskStore.list()
    const summary = {
      totalTasks: tasks.length,
      byStatus: {
        pending: tasks.filter((item) => item.status === 'pending').length,
        planned: tasks.filter((item) => item.status === 'planned').length,
        running: tasks.filter((item) => item.status === 'running').length,
        stopped: tasks.filter((item) => item.status === 'stopped').length,
        review: tasks.filter((item) => item.status === 'review').length,
        approved: tasks.filter((item) => item.status === 'approved').length,
        broken_down: tasks.filter((item) => item.status === 'broken_down').length,
        merged: tasks.filter((item) => item.status === 'merged').length,
        failed: tasks.filter((item) => item.status === 'failed').length,
      },
      runningInteractions: (await deps.interactions.listByStatus('running')).length,
      totalCost: await deps.interactions.projectTotal(),
      memory: await deps.memory.buildHealthSummary(),
    }

    printJSON(summary)
  })
}
