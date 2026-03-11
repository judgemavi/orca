import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import type { Executor } from '../executor/executor';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { WorkflowStore } from '../workflow/store';

/**
 * Shared dependency bag for entry-layer consumers (CLI, HTTP, handlers).
 * Domain functions should use narrow interfaces via Pick<AppDeps, ...> or their own types.
 */
export interface AppDeps {
  repoDir: string;
  db: OrcaDrizzleDB;
  sink?: EventSink;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  registry: ToolPluginRegistry;
  executor: Executor;
  queue: JobQueue;
  workflowStore: WorkflowStore;
}
