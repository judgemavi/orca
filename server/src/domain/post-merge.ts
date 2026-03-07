import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import { toErrorMessage } from '../shared/errors';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import { JOB_PRIORITIES } from '../types';
import { syncMemoryWithGit } from './memory-sync';
import { runRetro } from './retro';

export interface PostMergeEventSink {
  broadcast: (type: string, data: unknown) => void;
}

interface PostMergeDeps {
  repoDir: string;
  taskStore: TaskStore;
  interactions: InteractionStore;
  memoryStore: MemoryStore;
  configStore: ConfigStore;
  registry?: ToolPluginRegistry;
  sink?: PostMergeEventSink;
  queue?: JobQueue;
}

export function triggerPostMergeHooks(
  taskID: string,
  deps: PostMergeDeps,
): void {
  queueMicrotask(async () => {
    const config = await deps.configStore.load();
    const hooks = config.postMerge ?? {};
    if (hooks.enabled === false) {
      return;
    }

    if (hooks.retro !== false) {
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
            taskStore: deps.taskStore,
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

    if (hooks.memorySync !== false) {
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
