import type { DriverRegistry } from '../../driver/registry'
import type { Executor } from '../../executor/executor'
import { startMCPServer } from '../../mcp/server'
import type { EventSink } from '../../api/ws'
import type { ConfigStore } from '../../store/config'
import type { InteractionStore } from '../../store/interactions'
import type { MemoryStore } from '../../store/memory'
import type { TaskStore } from '../../store/tasks'
import type { JobQueue } from '../../queue/queue'

export async function runMCP(deps: {
  repoDir: string
  configStore: ConfigStore
  registry: DriverRegistry
  taskStore: TaskStore
  interactionStore: InteractionStore
  memoryStore: MemoryStore
  executor: Executor
  eventSink?: EventSink
  queue?: JobQueue
}) {
  await startMCPServer(deps)
}
