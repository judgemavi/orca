import type { EventSink } from '../api/ws';
import { isAutoRun } from '../config/config';
import { runExplore } from '../domain/explore';
import { runRetro } from '../domain/retro';
import type { Executor } from '../executor/executor';
import type { ToolPluginRegistry } from '../plugin/registry';
import { log } from '../shared/logger';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import type { Job } from '../types';
import { JOB_PRIORITIES } from '../types';
import { mergeTask } from '../workflows/merge';
import {
  approvePlan,
  breakdownTask,
  evaluateTaskWorkflow,
  generatePlan,
} from '../workflows/planning';
import { approveTask, runAIReviewWorkflow } from '../workflows/review';
import { resumeChain } from './chain';
import type { JobProcessor } from './processor';
import type { JobQueue } from './queue';

interface HandlerDeps {
  repoDir: string;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  executor: Executor;
  sink: EventSink;
  queue: JobQueue;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function shouldAutoRun(
  deps: { configStore: ConfigStore; taskStore: TaskStore },
  taskId: string,
  interactionType: Parameters<typeof isAutoRun>[1],
): Promise<boolean> {
  try {
    const [config, task] = await Promise.all([
      deps.configStore.load(),
      deps.taskStore.get(taskId),
    ]);
    return isAutoRun(config, interactionType, task?.autoRunOverrides);
  } catch {
    return false;
  }
}

async function enqueueNext(
  deps: HandlerDeps,
  taskId: string,
  type: Parameters<typeof isAutoRun>[1],
  payload?: Record<string, unknown>,
): Promise<void> {
  const auto = await shouldAutoRun(deps, taskId, type);
  if (!auto) return;
  log.info('auto-chaining', { taskId, next: type });
  await deps.queue.enqueue({
    type,
    taskId,
    priority: JOB_PRIORITIES[type],
    payload,
  });
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

      // Chain: evaluate → breakdown or plan
      if (evaluation.needsBreakdown) {
        await enqueueNext(deps, taskId, 'breakdown');
      } else {
        await enqueueNext(deps, taskId, 'plan');
      }

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

      // Chain: plan → auto-approve → code (via resumeChain)
      const auto = await shouldAutoRun(deps, taskId, 'code');
      if (auto) {
        try {
          await approvePlan(taskId, { taskStore: deps.taskStore });
          deps.sink.broadcast('plan.approved', { taskId, automated: true });
          await resumeChain(taskId, 'planned', deps);
        } catch (approveErr) {
          log.warn('auto-approve plan failed', {
            taskId,
            error: String(approveErr),
          });
        }
      }

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

  // review (AI review)
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

      // Chain: review → if approved → merge (via resumeChain); if rejected → re-run
      if (result.approved) {
        try {
          await approveTask(taskId, { taskStore: deps.taskStore });
          deps.sink.broadcast('task.approved', { taskId, automated: true });
          await resumeChain(taskId, 'approved', deps);
        } catch (approveErr) {
          log.warn('auto-approve task failed', {
            taskId,
            error: String(approveErr),
          });
        }
      } else {
        // Auto change-request loop: re-run with feedback, then review again
        const auto = await shouldAutoRun(deps, taskId, 'review');
        if (auto) {
          log.info('auto-requesting changes', {
            taskId,
            reviewId: result.reviewId,
          });
          await deps.queue.enqueue({
            type: 'code',
            taskId,
            priority: JOB_PRIORITIES.code,
            payload: { feedback: result.feedback, _autoReviewAfter: true },
          });
        }
      }

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
  // code (formerly 'run') — execute task implementation
  processor.register('code', async (job: Job) => {
    const taskId = job.taskId!;
    const feedback = str(job.payload?.feedback);
    const autoReviewAfter = Boolean(job.payload?._autoReviewAfter);

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

    // Chain: run → review (if task landed in 'review' status)
    if (result.status === 'review') {
      if (autoReviewAfter) {
        // Part of auto change-request loop — always review again
        log.info('auto-review after change request', { taskId });
        await deps.queue.enqueue({
          type: 'review',
          taskId,
          priority: JOB_PRIORITIES.review,
        });
      } else {
        await enqueueNext(deps, taskId, 'review');
      }
    }

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
        queue: deps.queue,
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
      // retro is already triggered by post-merge hooks in mergeTask
      return { taskId, status: result.status };
    } catch (err) {
      if (failBroadcast) {
        const error = err instanceof Error ? err.message : String(err);
        deps.sink.broadcast('merge.failed', { taskId, error });
      }
      throw err;
    }
  });

  // retro
  processor.register('retro', async (job: Job) => {
    const taskId = job.taskId!;
    deps.sink.broadcast('retro.started', { taskId });

    try {
      const config = await deps.configStore.load();
      const result = await runRetro(taskId, {
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        interactionStore: deps.interactionStore,
        memoryStore: deps.memoryStore,
        config,
        registry: deps.registry,
      });

      deps.sink.broadcast('retro.completed', {
        taskId,
        interactionId: result.interactionId,
        entriesCreated: result.memoryEntries.length,
      });
      return { taskId, interactionId: result.interactionId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast('retro.failed', { taskId, error });
      throw err;
    }
  });
}
