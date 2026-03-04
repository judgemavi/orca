import type { Hono } from 'hono';
import type { Executor } from '../../executor/executor';
import type { JobQueue } from '../../queue/queue';
import type { TaskStore } from '../../store/tasks';
import { JOB_PRIORITIES } from '../../types';
import {
  type RunOpts,
  RunWorkflowError,
  resumeTask,
  stopTask,
} from '../../workflows/run';
import type { EventSink } from '../ws';
import { broadcast, parseBody, safeErrorMessage } from './utils';

interface RunRequestBody {
  taskIds?: string[];
  tool?: string;
  model?: string;
  context?: string;
}

interface ResumeBody {
  sessionId?: string;
  feedback?: string;
  tool?: string;
  model?: string;
  context?: string;
}

export function registerRunHandlers(
  app: Hono,
  deps: {
    executor: Executor;
    taskStore: TaskStore;
    sink: EventSink;
    queue: JobQueue;
  },
) {
  const { executor, taskStore, sink, queue } = deps;

  app.post('/run/pending', async (c) => {
    const body = await parseBody<RunRequestBody>(c.req);
    const taskIDs = normalizeTaskIDs(body.taskIds);
    const tool = body.tool ?? '';
    const model = body.model ?? '';
    const context = body.context ?? '';

    if (taskIDs.length > 0) {
      const jobIds: string[] = [];
      for (const taskID of taskIDs) {
        const { id } = await queue.enqueue({
          type: 'run',
          taskId: taskID,
          priority: JOB_PRIORITIES.run,
          payload: { tool, model, context },
        });
        jobIds.push(id);
      }
      return c.json(
        { data: { status: 'queued', taskIds: taskIDs, jobIds } },
        202,
      );
    }

    // Enqueue all pending/runnable tasks
    const pending = (await taskStore.list()).filter((t) =>
      ['pending', 'planned', 'failed', 'review'].includes(t.status),
    );
    const jobIds: string[] = [];
    for (const task of pending) {
      const { id } = await queue.enqueue({
        type: 'run',
        taskId: task.id,
        priority: JOB_PRIORITIES.run,
        payload: { tool, model, context },
      });
      jobIds.push(id);
    }
    return c.json(
      { data: { status: 'queued', taskIds: pending.map((t) => t.id), jobIds } },
      202,
    );
  });

  app.post('/tasks/start', async (c) => {
    const body = await parseBody<RunRequestBody>(c.req);
    const taskIDs = normalizeTaskIDs(body.taskIds);
    const tool = body.tool ?? '';
    const model = body.model ?? '';
    const context = body.context ?? '';

    const jobIds: string[] = [];
    for (const taskID of taskIDs) {
      const { id } = await queue.enqueue({
        type: 'run',
        taskId: taskID,
        priority: JOB_PRIORITIES.run,
        payload: { tool, model, context },
      });
      jobIds.push(id);
    }

    return c.json(
      { data: { status: 'queued', taskIds: taskIDs, jobIds } },
      202,
    );
  });

  app.post('/tasks/:id/start', async (c) => {
    const taskID = c.req.param('id');
    const body = await parseBody<RunRequestBody>(c.req);
    const { id: jobId } = await queue.enqueue({
      type: 'run',
      taskId: taskID,
      priority: JOB_PRIORITIES.run,
      payload: {
        tool: body.tool ?? '',
        model: body.model ?? '',
        context: body.context ?? '',
      },
    });
    return c.json({ data: { status: 'queued', taskId: taskID, jobId } }, 202);
  });

  app.post('/tasks/:id/resume', async (c) => {
    const taskID = c.req.param('id');
    const body = await parseBody<ResumeBody>(c.req);

    try {
      const result = await resumeTask(
        executor,
        taskStore,
        taskID,
        body.feedback ?? '',
        toRunOptions(body),
      );
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof RunWorkflowError) {
        return c.json({ error: safeErrorMessage(error) }, error.status);
      }
      return c.json({ error: safeErrorMessage(error) }, 500);
    }
  });

  app.post('/tasks/:id/stop', async (c) => {
    const taskID = c.req.param('id');

    try {
      await stopTask(executor, taskStore, taskID);
      broadcast(sink, 'task.updated', { id: taskID, status: 'stopped' });
      return c.json({ data: { taskId: taskID, status: 'stopped' } });
    } catch (error) {
      if (error instanceof RunWorkflowError) {
        return c.json({ error: safeErrorMessage(error) }, error.status);
      }
      return c.json({ error: safeErrorMessage(error) }, 500);
    }
  });

  app.post('/tasks/:id/cancel', async (c) => {
    const taskID = c.req.param('id');

    try {
      await stopTask(executor, taskStore, taskID);
      broadcast(sink, 'task.updated', { id: taskID, status: 'stopped' });
      return c.json({ data: { taskId: taskID, status: 'stopped' } });
    } catch (error) {
      if (error instanceof RunWorkflowError) {
        return c.json({ error: safeErrorMessage(error) }, error.status);
      }
      return c.json({ error: safeErrorMessage(error) }, 500);
    }
  });
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
