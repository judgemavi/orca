import { zValidator } from '@hono/zod-validator';
import { SYSTEM_JOB_PRIORITIES } from '@orca/types';
import { type Context, Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import type { Executor } from '../../executor/executor';
import type { JobQueue } from '../../queue/queue';
import { resumeSchema, runRequestSchema } from '../../schemas/tasks';
import type { InteractionStore } from '../../store/interactions';
import * as taskStoreFns from '../../store/tasks';
import { resolveStepMeta } from '../../workflow/paths';
import type { WorkflowStore } from '../../workflow/store';
import {
  isRunWorkflowError,
  type RunOpts,
  resumeTask,
  stopTask,
} from '../../workflows/run';
import type { EventSink } from '../ws';
import { broadcast, safeErrorMessage } from './utils';

export function runRoutes(deps: {
  executor: Executor;
  db: OrcaDrizzleDB;
  sink: EventSink;
  interactionStore: InteractionStore;
  queue: JobQueue;
  workflowStore: WorkflowStore;
}) {
  const { executor, db, interactionStore, queue } = deps;

  return new Hono()
    .post('/tasks/start', zValidator('json', runRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const taskIDs = normalizeTaskIDs(body.taskIds);
      const jobIds = await enqueueTaskSteps(
        db,
        queue,
        deps.workflowStore,
        taskIDs,
        body,
      );

      return c.json({ status: 'queued', taskIds: taskIDs, jobIds }, 202);
    })

    .post(
      '/tasks/:id/start',
      zValidator('json', runRequestSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');
        const [jobId] = await enqueueTaskSteps(
          db,
          queue,
          deps.workflowStore,
          [taskID],
          body,
        );
        return c.json({ status: 'queued', taskId: taskID, jobId }, 202);
      },
    )

    .post('/tasks/:id/resume', zValidator('json', resumeSchema), async (c) => {
      const taskID = c.req.param('id');
      const body = c.req.valid('json');

      try {
        const result = await resumeTask(
          executor,
          db,
          taskID,
          body.feedback ?? '',
          toRunOptions(body),
          interactionStore,
        );
        return c.json(result);
      } catch (error) {
        if (isRunWorkflowError(error)) {
          return c.json({ error: safeErrorMessage(error) }, error.status);
        }
        return c.json({ error: safeErrorMessage(error) }, 500);
      }
    })

    .post('/tasks/:id/stop', (c) => stopTaskRoute(c, deps))
    .post('/tasks/:id/cancel', (c) => stopTaskRoute(c, deps));
}

function toRunOptions(body: {
  tool?: string;
  model?: string;
  context?: string;
}): RunOpts {
  return {
    toolOverride: body.tool ?? '',
    modelOverride: body.model ?? '',
    context: body.context ?? '',
  };
}

function normalizeTaskIDs(taskIDs: string[] | undefined): string[] {
  if (!Array.isArray(taskIDs) || taskIDs.length === 0) return [];
  return taskIDs.map((value) => String(value ?? '').trim()).filter(Boolean);
}

async function enqueueTaskSteps(
  db: OrcaDrizzleDB,
  queue: JobQueue,
  workflowStore: WorkflowStore,
  taskIDs: string[],
  body: {
    tool?: string;
    model?: string;
    context?: string;
  },
): Promise<string[]> {
  const jobIds: string[] = [];
  for (const taskID of taskIDs) {
    const task = await taskStoreFns.getTask(db, taskID).catch(() => null);
    let jobType = 'evaluate';
    let priority = SYSTEM_JOB_PRIORITIES.evaluate;
    if (task?.currentStep) {
      jobType = task.currentStep;
      try {
        const compiled = workflowStore.resolve(task.workflow ?? undefined);
        priority =
          resolveStepMeta(compiled.machine, task.currentStep).meta.priority ??
          5;
      } catch {
        priority = 5;
      }
    }
    const { id } = await queue.enqueue({
      type: jobType,
      taskId: taskID,
      priority,
      payload: {
        tool: body.tool ?? '',
        model: body.model ?? '',
        context: body.context ?? '',
      },
    });
    jobIds.push(id);
  }
  return jobIds;
}

async function stopTaskRoute(
  c: Context,
  deps: {
    executor: Executor;
    db: OrcaDrizzleDB;
    sink: EventSink;
  },
) {
  const taskID = c.req.param('id');
  if (!taskID) {
    return c.json({ error: 'task id required' }, 400);
  }

  try {
    await stopTask(deps.executor, deps.db, deps.sink, taskID);
    broadcast(deps.sink, 'task.updated', { id: taskID, status: 'stopped' });
    return c.json({ taskId: taskID, status: 'stopped' });
  } catch (error) {
    if (isRunWorkflowError(error)) {
      return c.json({ error: safeErrorMessage(error) }, error.status);
    }
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
}
