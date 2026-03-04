import { bootstrap } from '../bootstrap'
import { runCLI } from '../cli'

export async function runCLIEntrypoint(repoDir: string) {
  const ctx = await bootstrap({ repoDir })

  try {
    await runCLI({
      repoDir,
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      interactionStore: ctx.interactionStore,
      memoryStore: ctx.memoryStore,
      registry: ctx.registry,
      executor: ctx.executor,
      queue: ctx.queue,
    })
  } finally {
    ctx.database.close()
  }
}
