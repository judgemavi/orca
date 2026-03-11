import { zValidator } from '@hono/zod-validator';
import { JOB_PRIORITIES } from '@orca/types';
import { type Context, Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import type { Executor } from '../../executor/executor';
import type { JobQueue } from '../../queue/queue';
import { resumeSchema, runRequestSchema } from '../../schemas/tasks';
import type { InteractionStore } from '../../store/interactions';
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
}) {
  const { executor, db, interactionStore, queue } = deps;

  return new Hono()
    .post('/tasks/start', zValidator('json', runRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const taskIDs = normalizeTaskIDs(body.taskIds);
      const jobIds = await enqueueCodeJobs(queue, taskIDs, body);

      return c.json({ status: 'queued', taskIds: taskIDs, jobIds }, 202);
    })

    .post(
      '/tasks/:id/start',
      zValidator('json', runRequestSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');
        const [jobId] = await enqueueCodeJobs(queue, [taskID], body);
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

async function enqueueCodeJobs(
  queue: JobQueue,
  taskIDs: string[],
  body: {
    tool?: string;
    model?: string;
    context?: string;
  },
): Promise<string[]> {
  const jobIds: string[] = [];
  for (const taskID of taskIDs) {
    const { id } = await queue.enqueue({
      type: 'code',
      taskId: taskID,
      priority: JOB_PRIORITIES.code,
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
