import type { EventSink } from '../api/ws';
import { isAutoRun } from '../config/config';
import { runExplore } from '../domain/explore';
import { runRetro } from '../domain/retro';
import { log } from '../shared/logger';
import * as configStore from '../store/config';
import * as questionStore from '../store/questions';
import * as taskStore from '../store/tasks';
import type { AppDeps } from '../types/deps';
import type { Job } from '../types/models';
import {
  initWorkflow,
  resolveStepMeta,
  type WorkflowEngineDeps,
} from '../workflow/engine';
import {
  acceptBreakdown,
  breakdownTask,
  evaluateTaskWorkflow,
} from '../workflows/planning';
import type { JobProcessor } from './processor';
import { createGenericStepHandler } from './step-handler';

type HandlerDeps = AppDeps & { sink: EventSink };

function engineDeps(deps: HandlerDeps): WorkflowEngineDeps {
  return {
    db: deps.db,
    sink: deps.sink,
    queue: deps.queue,
    workflowStore: deps.workflowStore,
  };
}

export function registerJobHandlers(
  processor: JobProcessor,
  deps: HandlerDeps,
): void {
  // -------------------------------------------------------------------------
  // System-controlled handlers (not workflow steps)
  // -------------------------------------------------------------------------

  // evaluate — runs before workflow starts, determines task path
  processor.register('evaluate', async (job: Job) => {
    const taskId = job.taskId!;

    deps.sink.broadcast('evaluate.started', { taskId });

    try {
      const { evaluation, sessionId } = await evaluateTaskWorkflow(taskId, {
        repoDir: deps.repoDir,
        db: deps.db,
        sink: deps.sink,
        interactions: deps.interactionStore,
        registry: deps.registry,
        workflowStore: deps.workflowStore,
        toolOverride: job.payload?.tool ?? '',
        modelOverride: job.payload?.model ?? '',
        resumeSessionID: job.payload?.resumeSessionID || undefined,
        feedback: job.payload?.feedback || undefined,
      });

      deps.sink.broadcast('evaluate.completed', { taskId, evaluation });

      if (evaluation.needsUserInput && evaluation.userInputQuestion) {
        await taskStore.updateTask(deps.db, deps.sink, taskId, {
          status: 'stopped',
        });
        await questionStore.createQuestion(deps.db, {
          taskId,
          question: evaluation.userInputQuestion,
        });
        deps.sink.broadcast('task.awaiting_input', {
          taskId,
          question: evaluation.userInputQuestion,
        });
        return { evaluation, awaitingInput: true };
      }

      if (evaluation.needsBreakdown) {
        deps.sink.broadcast('breakdown.started', { taskId });
        try {
          const result = await breakdownTask(
            {
              taskId,
              toolOverride: job.payload?.tool ?? '',
              modelOverride: job.payload?.model ?? '',
            },
            {
              repoDir: deps.repoDir,
              db: deps.db,
              sink: deps.sink,
              interactions: deps.interactionStore,
              registry: deps.registry,
              memory: deps.memoryStore,
            },
          );

          const accepted = await acceptBreakdown(taskId, result.proposed, {
            db: deps.db,
            sink: deps.sink,
            queue: deps.queue,
          });

          if (result.interactionId) {
            await deps.interactionStore.finish(result.interactionId, {
              status: 'completed',
              output: JSON.stringify({
                result: 'success',
                data: { proposed: result.proposed, accepted: true },
              }),
            });
          }

          deps.sink.broadcast('breakdown.completed', {
            taskId,
            proposed: result.proposed,
            createdIds: accepted.createdIds,
            interactionId: result.interactionId,
          });
          deps.sink.broadcast('task.updated', {
            id: taskId,
            status: 'broken_down',
          });

          log.info('evaluate triggered breakdown', {
            taskId,
            created: accepted.createdIds.length,
          });
          return {
            evaluation,
            brokenDown: true,
            createdIds: accepted.createdIds,
          };
        } catch (breakdownErr) {
          const error =
            breakdownErr instanceof Error
              ? breakdownErr.message
              : String(breakdownErr);
          deps.sink.broadcast('breakdown.failed', { taskId, error });
          throw breakdownErr;
        }
      }

      // Ready → init workflow and enqueue first step (only if not already initialized)
      const task = await taskStore.getTask(deps.db, taskId);
      if (task?.currentStep) {
        log.info('evaluate: workflow already initialized, skipping re-init', {
          taskId,
          currentStep: task.currentStep,
        });
        return { evaluation, alreadyInitialized: true };
      }

      await initWorkflow(taskId, undefined, engineDeps(deps));
      const updated = await taskStore.getTask(deps.db, taskId);
      const firstStep = updated?.currentStep ?? 'plan';
      const auto = await shouldAutoRun(deps, taskId, firstStep);
      if (auto) {
        const compiled = deps.workflowStore.resolve(
          updated?.workflow ?? undefined,
        );
        let stepPriority = 5;
        try {
          stepPriority =
            resolveStepMeta(compiled.machine, firstStep).meta.priority ?? 5;
        } catch {}
        await deps.queue.enqueue({
          type: firstStep,
          taskId,
          priority: stepPriority,
        });
      }

      return { evaluation };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast('evaluate.failed', { taskId, error });
      throw err;
    }
  });

  // breakdown — manual trigger
  processor.register('breakdown', async (job: Job) => {
    const taskId = job.taskId ?? undefined;
    deps.sink.broadcast('breakdown.started', { taskId: taskId ?? '' });

    try {
      const result = await breakdownTask(
        {
          taskId: taskId,
          goal: job.payload?.goal ?? '',
          toolOverride: job.payload?.tool ?? '',
          modelOverride: job.payload?.model ?? '',
        },
        {
          repoDir: deps.repoDir,
          db: deps.db,
          sink: deps.sink,
          interactions: deps.interactionStore,
          registry: deps.registry,
          memory: deps.memoryStore,
        },
      );

      if (taskId) {
        try {
          const accepted = await acceptBreakdown(taskId, result.proposed, {
            db: deps.db,
            sink: deps.sink,
            queue: deps.queue,
          });
          if (result.interactionId) {
            await deps.interactionStore.finish(result.interactionId, {
              status: 'completed',
              output: JSON.stringify({
                result: 'success',
                data: { proposed: result.proposed, accepted: true },
              }),
            });
          }
          deps.sink.broadcast('breakdown.completed', {
            taskId,
            proposed: result.proposed,
            createdIds: accepted.createdIds,
            interactionId: result.interactionId,
          });
          deps.sink.broadcast('task.updated', {
            id: taskId,
            status: 'broken_down',
          });
          log.info('breakdown completed', {
            taskId,
            created: accepted.createdIds.length,
          });
        } catch (acceptErr) {
          log.warn('breakdown accept failed', {
            taskId,
            error: String(acceptErr),
          });
          throw acceptErr;
        }
      } else {
        deps.sink.broadcast('breakdown.completed', {
          taskId: '',
          proposed: result.proposed,
          interactionId: result.interactionId,
        });
      }

      return { proposed: result.proposed, interactionId: result.interactionId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast('breakdown.failed', { taskId: taskId ?? '', error });
      throw err;
    }
  });

  // explore — manual trigger, gated by memory.enabled
  processor.register('explore', async (job: Job) => {
    const config = await configStore.loadConfig(deps.db);
    if (config.memory?.enabled === false) {
      log.info('explore skipped — memory disabled');
      return { skipped: true };
    }

    deps.sink.broadcast('explore.started', {});

    try {
      const result = await runExplore({
        repoDir: deps.repoDir,
        interactions: deps.interactionStore,
        memory: deps.memoryStore,
        config,
        registry: deps.registry,
        query: job.payload?.query ?? '',
        toolOverride: job.payload?.tool ?? '',
        modelOverride: job.payload?.model ?? '',
      });

      deps.sink.broadcast('explore.completed', { path: result.path });
      return { path: result.path, files: result.files, seeded: result.seeded };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast('explore.failed', { error });
      throw err;
    }
  });

  // retro — system-controlled, gated by memory.enabled
  processor.register('retro', async (job: Job) => {
    const taskId = job.taskId!;
    const config = await configStore.loadConfig(deps.db);
    if (config.memory?.enabled === false) {
      log.info('retro skipped — memory disabled', { taskId });
      return { taskId, skipped: true };
    }

    deps.sink.broadcast('retro.started', { taskId });

    try {
      const result = await runRetro(taskId, {
        repoDir: deps.repoDir,
        db: deps.db,
        interactionStore: deps.interactionStore,
        memoryStore: deps.memoryStore,
        config,
        registry: deps.registry,
        workflowStore: deps.workflowStore,
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

  // -------------------------------------------------------------------------
  // Generic fallback for ALL workflow steps (plan, code, review, merge, custom)
  // -------------------------------------------------------------------------
  processor.setFallback(async (job: Job) => {
    const stepName = job.type;
    log.info('routing to step handler', { stepName, taskId: job.taskId });
    const handler = createGenericStepHandler(stepName, deps);
    return handler(job);
  });
}

async function shouldAutoRun(
  deps: HandlerDeps,
  taskId: string,
  stepName: string,
): Promise<boolean> {
  try {
    const [config, task] = await Promise.all([
      configStore.loadConfig(deps.db),
      taskStore.getTask(deps.db, taskId),
    ]);
    const compiled = deps.workflowStore.resolve(task?.workflow ?? undefined);
    let stepAutoRun: boolean | undefined;
    try {
      stepAutoRun = resolveStepMeta(compiled.machine, stepName).meta.autoRun;
    } catch {
      stepAutoRun = undefined;
    }
    return isAutoRun({
      config,
      stepName,
      stepAutoRun,
      taskOverrides: task?.autoRunOverrides,
    });
  } catch {
    return false;
  }
}
