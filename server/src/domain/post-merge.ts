import { JOB_PRIORITIES } from '@orca/types';
import type { OrcaDrizzleDB } from '../db/connection';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import { toErrorMessage } from '../shared/errors';
import * as configStore from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import { syncMemoryWithGit } from './memory-sync';
import { runRetro } from './retro';

export interface PostMergeEventSink {
  broadcast: (type: string, data: unknown) => void;
}

interface PostMergeDeps {
  repoDir: string;
  db: OrcaDrizzleDB;
  interactions: InteractionStore;
  memoryStore: MemoryStore;
  registry?: ToolPluginRegistry;
  sink?: PostMergeEventSink;
  queue?: JobQueue;
}

export function triggerPostMergeHooks(
  taskID: string,
  deps: PostMergeDeps,
): void {
  queueMicrotask(async () => {
    const config = await configStore.loadConfig(deps.db);
    if (config.postMerge?.enabled === false) {
      return;
    }

    const mem = config.memory ?? {};
    if (mem.enabled !== false && mem.retro !== false) {
      if (deps.queue) {
        await deps.queue.enqueue({
          type: 'retro',
          taskId: taskID,
          priority: JOB_PRIORITIES.retro,
        });
      } else {
        try {
          const result = await runRetro(taskID, {
            repoDir: deps.repoDir,
            db: deps.db,
            interactionStore: deps.interactions,
            memoryStore: deps.memoryStore,
            config,
            registry: deps.registry,
          });
          deps.sink?.broadcast('retro.completed', {
            taskId: taskID,
            interactionId: result.interactionId,
            entriesCreated: result.memoryEntries.length,
            automated: true,
          });
        } catch (error) {
          deps.sink?.broadcast('retro.failed', {
            taskId: taskID,
            error: toErrorMessage(error),
          });
        }
      }
    }

    if (mem.enabled !== false && mem.sync !== false) {
      try {
        const contextDeps = deps.registry
          ? { config, registry: deps.registry, interactions: deps.interactions }
          : undefined;
        const result = await syncMemoryWithGit(
          deps.repoDir,
          deps.memoryStore,
          contextDeps,
        );
        deps.sink?.broadcast('memory.sync.completed', result);
      } catch (error) {
        deps.sink?.broadcast('memory.sync.failed', {
          taskId: taskID,
          error: toErrorMessage(error),
        });
      }
    }
  });
}
