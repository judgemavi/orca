import { zValidator } from '@hono/zod-validator';
import { type Context, Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import type { Executor } from '../../executor/executor';
import type { JobQueue } from '../../queue/queue';
import { resumeSchema, runRequestSchema } from '../../schemas/tasks';
import { toErrorMessage } from '../../shared/errors';
import type { InteractionStore } from '../../store/interactions';
import type { WorkflowStore } from '../../workflow/store';
import { isRunWorkflowError, resumeTask, stopTask } from '../../workflows/run';
import { resolveStepJob } from '../../workflows/tasks';
import type { EventSink } from '../ws';
import { broadcast } from './utils';

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
    .post(
      '/tasks/:id/start',
      zValidator('json', runRequestSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');
        const jobId = await enqueueTaskStep(
          db,
          queue,
          deps.workflowStore,
          taskID,
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
          {
            toolOverride: body.tool,
            modelOverride: body.model,
            context: body.context,
          },
          interactionStore,
        );
        return c.json(result);
      } catch (error) {
        if (isRunWorkflowError(error)) {
          return c.json({ error: toErrorMessage(error) }, error.status);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })

    .post('/tasks/:id/stop', (c) => stopTaskRoute(c, deps));
}

async function enqueueTaskStep(
  db: OrcaDrizzleDB,
  queue: JobQueue,
  workflowStore: WorkflowStore,
  taskID: string,
  body: { tool?: string; model?: string; context?: string },
): Promise<string> {
  const { type, priority } = await resolveStepJob(db, taskID, workflowStore);
  const { id } = await queue.enqueue({
    type,
    taskId: taskID,
    priority,
    payload: {
      tool: body.tool ?? '',
      model: body.model ?? '',
      context: body.context ?? '',
    },
  });
  return id;
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
      return c.json({ error: toErrorMessage(error) }, error.status);
    }
    return c.json({ error: toErrorMessage(error) }, 500);
  }
}
