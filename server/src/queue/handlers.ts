import type { EventSink } from '../api/ws';
import { runExplore } from '../domain/explore';
import type { DriverRegistry } from '../driver/registry';
import type { Executor } from '../executor/executor';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import type { Job } from '../types';
import { mergeTask } from '../workflows/merge';
import {
  breakdownTask,
  evaluateTaskWorkflow,
  generatePlan,
} from '../workflows/planning';
import { runAIReviewWorkflow } from '../workflows/review';
import type { JobProcessor } from './processor';

interface HandlerDeps {
  repoDir: string;
  configStore: ConfigStore;
  registry: DriverRegistry;
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  executor: Executor;
  sink: EventSink;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function registerJobHandlers(
  processor: JobProcessor,
  deps: HandlerDeps,
): void {
  // evaluate
  processor.register('evaluate', async (job: Job) => {
    const taskId = job.taskId!;
    deps.sink.broadcast('evaluate.started', { taskId });

    try {
      const evaluation = await evaluateTaskWorkflow(taskId, {
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        interactions: deps.interactionStore,
        configStore: deps.configStore,
        registry: deps.registry,
        toolOverride: str(job.payload?.tool),
        modelOverride: str(job.payload?.model),
      });

      deps.sink.broadcast('evaluate.completed', { taskId, evaluation });
      return { evaluation };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast('evaluate.failed', { taskId, error });
      throw err;
    }
  });

  // plan
  processor.register('plan', async (job: Job) => {
    const taskId = job.taskId!;
    deps.sink.broadcast('plan.generating', { taskId });

    try {
      const result = await generatePlan(taskId, {
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        interactions: deps.interactionStore,
        configStore: deps.configStore,
        registry: deps.registry,
        memory: deps.memoryStore,
        toolOverride: str(job.payload?.tool),
        modelOverride: str(job.payload?.model),
        feedback: str(job.payload?.feedback),
      });

      await deps.taskStore.setPlan(taskId, result.plan);
      deps.sink.broadcast('plan.completed', { taskId, plan: result.plan });
      return { plan: result.plan, interactionId: result.interactionId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast('plan.failed', { taskId, error });
      throw err;
    }
  });

  // breakdown
  processor.register('breakdown', async (job: Job) => {
    const taskId = job.taskId ?? undefined;
    deps.sink.broadcast('breakdown.started', { taskId: taskId ?? '' });

    try {
      const result = await breakdownTask(
        {
          taskId: taskId,
          goal: str(job.payload?.goal),
          toolOverride: str(job.payload?.tool),
          modelOverride: str(job.payload?.model),
        },
        {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          interactions: deps.interactionStore,
          configStore: deps.configStore,
          registry: deps.registry,
          memory: deps.memoryStore,
        },
      );

      deps.sink.broadcast('breakdown.completed', {
        taskId: result.taskId ?? taskId ?? '',
        proposed: result.proposed,
        interactionId: result.interactionId,
      });
      return { proposed: result.proposed, interactionId: result.interactionId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast('breakdown.failed', { taskId: taskId ?? '', error });
      throw err;
    }
  });

  // review
  processor.register('review', async (job: Job) => {
    const taskId = job.taskId!;
    deps.sink.broadcast('ai_review.started' as string, { taskId });

    try {
      const result = await runAIReviewWorkflow(taskId, {
        repoDir: deps.repoDir,
        configStore: deps.configStore,
        registry: deps.registry,
        taskStore: deps.taskStore,
        interactions: deps.interactionStore,
        prompt: str(job.payload?.prompt),
        toolOverride: str(job.payload?.tool),
        modelOverride: str(job.payload?.model),
      });

      deps.sink.broadcast('ai_review.completed', {
        taskId: result.taskId,
        approved: result.approved,
        feedback: result.feedback,
        tool: result.tool,
      });
      return {
        approved: result.approved,
        feedback: result.feedback,
        reviewId: result.reviewId,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast('ai_review.failed', { taskId, error });
      throw err;
    }
  });

  // run — call internal directly to avoid re-enqueue loop
  processor.register('run', async (job: Job) => {
    const taskId = job.taskId!;
    const feedback = str(job.payload?.feedback);

    let resumeSessionID: string | undefined;
    if (feedback) {
      const task = await deps.taskStore.get(taskId);
      resumeSessionID = task?.sessionId ?? undefined;
    }

    const result = await deps.executor.runTaskByIDInternal(taskId, {
      runID: crypto.randomUUID(),
      toolOverride: str(job.payload?.tool),
      modelOverride: str(job.payload?.model),
      context: str(job.payload?.context),
      resumeSessionID,
      feedback,
    });

    return { taskId: result.taskID, status: result.status };
  });

  // explore
  processor.register('explore', async (job: Job) => {
    deps.sink.broadcast('explore.started' as string, {});

    try {
      const config = await deps.configStore.load();
      const result = await runExplore({
        repoDir: deps.repoDir,
        interactions: deps.interactionStore,
        memory: deps.memoryStore,
        config,
        registry: deps.registry,
        query: str(job.payload?.query),
        toolOverride: str(job.payload?.tool),
        modelOverride: str(job.payload?.model),
      });

      deps.sink.broadcast('explore.completed', { path: result.path });
      return { path: result.path, files: result.files, seeded: result.seeded };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast('explore.failed', { error });
      throw err;
    }
  });

  // merge
  processor.register('merge', async (job: Job) => {
    const taskId = job.taskId!;
    deps.sink.broadcast('merge.started', { taskId, mode: 'single' });

    let failBroadcast = true;
    try {
      const result = await mergeTask(taskId, {
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        configStore: deps.configStore,
        interactions: deps.interactionStore,
        memoryStore: deps.memoryStore,
        registry: deps.registry,
        sink: deps.sink,
      });

      if (result.status !== 'merged') {
        failBroadcast = false;
        deps.sink.broadcast('merge.failed', {
          taskId,
          error: result.error || 'merge failed',
        });
        throw new Error(result.error || 'merge failed');
      }

      failBroadcast = false;
      deps.sink.broadcast('merge.completed', { taskId, result });
      return { taskId, status: result.status };
    } catch (err) {
      if (failBroadcast) {
        const error = err instanceof Error ? err.message : String(err);
        deps.sink.broadcast('merge.failed', { taskId, error });
      }
      throw err;
    }
  });
}
