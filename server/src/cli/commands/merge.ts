import type { Command } from 'commander'
import type { ConfigStore } from '../../store/config'
import type { InteractionStore } from '../../store/interactions'
import type { MemoryStore } from '../../store/memory'
import type { TaskStore } from '../../store/tasks'
import { mergeAllApproved, mergeTask } from '../../workflows/merge'
import { printJSON } from '../format'
import { confirm, pickFromList } from '../helpers'

export function registerMergeCommands(
  program: Command,
  deps: {
    repoDir: string
    taskStore: TaskStore
    configStore: ConfigStore
    interactionStore: InteractionStore
    memoryStore: MemoryStore
  },
) {
  const merge = program.command('merge').description('Merge task(s)')

  merge
    .argument('[taskId]', 'specific task id')
    .option('--all', 'merge all approved tasks')
    .action(async (taskID: string | undefined, opts: { all?: boolean }) => {
      const explicit = (taskID ?? '').trim()
      if (explicit) {
        const result = await mergeTask(explicit, {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          configStore: deps.configStore,
          interactions: deps.interactionStore,
          memoryStore: deps.memoryStore,
        })
        printJSON(result)
        return
      }

      if (!canPrompt() || opts.all) {
        const result = await mergeAllApproved({
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          configStore: deps.configStore,
          interactions: deps.interactionStore,
          memoryStore: deps.memoryStore,
        })
        printJSON(result)
        return
      }

      const approved = await deps.taskStore.listByStatus('approved')
      if (approved.length === 0) {
        throw new Error('no approved tasks to merge')
      }

      const choice = await pickFromList(
        'Merge mode',
        [
          { label: 'Merge all approved tasks', value: '__all__' },
          ...approved.map((task) => ({
            label: `${task.id.slice(0, 8)}  ${task.title}`,
            value: task.id,
          })),
        ],
        '__all__',
      )

      if (choice === '__all__') {
        const ok = await confirm(`Merge all ${approved.length} approved tasks?`, true)
        if (!ok) {
          printJSON({ merged: [], failed: [], cancelled: true })
          return
        }
        const result = await mergeAllApproved({
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          configStore: deps.configStore,
          interactions: deps.interactionStore,
          memoryStore: deps.memoryStore,
        })
        printJSON(result)
        return
      }

      const result = await mergeTask(choice, {
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        configStore: deps.configStore,
        interactions: deps.interactionStore,
        memoryStore: deps.memoryStore,
      })
      printJSON(result)
    })
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json')
}
