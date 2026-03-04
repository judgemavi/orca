import type { Context, Hono } from 'hono';
import type { DriverRegistry } from '../../driver/registry';
import type { Executor } from '../../executor/executor';
import type { JobQueue } from '../../queue/queue';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import type { ProposedTask } from '../../types';
import { JOB_PRIORITIES } from '../../types';
import {
  acceptBreakdown,
  breakdownTask,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
} from '../../workflows/planning';
import { approveTask } from '../../workflows/review';
import type { EventSink } from '../ws';
import { broadcast, parseBody, safeErrorMessage } from './utils';

interface ToolModelBody {
  tool?: string;
  model?: string;
}

interface RequestChangesBody extends ToolModelBody {
  feedback?: string;
  interactionId?: string;
}

interface BreakdownAcceptBody {
  interactionId?: string;
  tasks?: ProposedTask[];
}

interface BreakdownRejectBody {
  interactionId?: string;
}

export function registerTaskWorkflowHandlers(
  app: Hono,
  deps: {
    repoDir: string;
    taskStore: TaskStore;
    interactionStore: InteractionStore;
    configStore: ConfigStore;
    registry: DriverRegistry;
    executor: Executor;
    sink: EventSink;
    queue: JobQueue;
  },
) {
  app.post('/tasks/:id/approve', async (c) => {
    const taskID = c.req.param('id');
    let updated;
    try {
      updated = await approveTask(taskID, { taskStore: deps.taskStore });
    } catch (error) {
      return errorResponse(c, error);
    }
    broadcast(
      deps.sink,
      'task.updated',
      updated as unknown as Record<string, unknown>,
    );
    return c.json({ data: updated });
  });

  app.post('/tasks/:id/request-changes', async (c) => {
    const taskID = c.req.param('id');
    const task = await deps.taskStore.get(taskID);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (task.status !== 'review') {
      return c.json(
        { error: 'task must be in review status to request changes' },
        400,
      );
    }

    const body = await parseBody<RequestChangesBody>(c.req);
    const feedback = body.feedback?.trim() ?? '';
    if (!feedback) {
      return c.json({ error: 'feedback is required' }, 400);
    }

    const tool = body.tool ?? '';
    const model = body.model ?? '';
    const interactionId = body.interactionId ?? '';

    await deps.taskStore.addReview(taskID, feedback, interactionId);
    await deps.interactionStore.supersedeReviewPhase(taskID);

    const { id: jobId } = await deps.queue.enqueue({
      type: 'run',
      taskId: taskID,
      priority: JOB_PRIORITIES.run,
      payload: { tool, model },
    });

    return c.json({ data: { status: 'queued', taskId: taskID, jobId } }, 202);
  });

  app.post('/tasks/:id/ai-review', async (c) => {
    const taskID = c.req.param('id');
    const task = await deps.taskStore.get(taskID);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (task.status !== 'review') {
      return c.json(
        {
          error: `task must be in review status, got ${JSON.stringify(task.status)}`,
        },
        400,
      );
    }

    const body = await parseBody<ToolModelBody & { prompt?: string }>(c.req);
    const runInteractions = await deps.interactionStore.listByPhase(
      taskID,
      'run',
    );
    const latest = runInteractions.find(
      (item) => item.status === 'completed' && Boolean(item.diff?.trim()),
    );
    const diff = latest?.diff?.trim() ?? '';
    if (!diff) {
      return c.json(
        { error: 'no completed run interaction with diff found' },
        400,
      );
    }

    const { id: jobId } = await deps.queue.enqueue({
      type: 'review',
      taskId: taskID,
      priority: JOB_PRIORITIES.review,
      payload: {
        prompt: body.prompt ?? '',
        tool: body.tool ?? '',
        model: body.model ?? '',
      },
    });

    return c.json({ data: { status: 'queued', taskId: taskID, jobId } }, 202);
  });

  app.post('/tasks/:id/evaluate', async (c) => {
    const taskID = c.req.param('id');
    const body = await parseBody<ToolModelBody>(c.req);

    const { id: jobId } = await deps.queue.enqueue({
      type: 'evaluate',
      taskId: taskID,
      priority: JOB_PRIORITIES.evaluate,
      payload: { tool: body.tool ?? '', model: body.model ?? '' },
    });

    broadcast(deps.sink, 'evaluate.started', { taskId: taskID });
    return c.json({ data: { taskId: taskID, jobId, status: 'queued' } }, 202);
  });

  app.post('/tasks/:id/breakdown', async (c) => {
    const taskID = c.req.param('id');
    const task = await deps.taskStore.get(taskID);
    if (!task) return c.json({ error: 'task not found' }, 404);

    const body = await parseBody<ToolModelBody>(c.req);

    const { id: jobId } = await deps.queue.enqueue({
      type: 'breakdown',
      taskId: taskID,
      priority: JOB_PRIORITIES.breakdown,
      payload: { tool: body.tool ?? '', model: body.model ?? '' },
    });

    return c.json({ data: { taskId: taskID, jobId, status: 'queued' } }, 202);
  });

  app.post('/tasks/:id/breakdown/accept', async (c) => {
    const parentID = c.req.param('id');

    const body = await parseBody<BreakdownAcceptBody>(c.req);
    const interactionID = body.interactionId?.trim() ?? '';
    let proposed = Array.isArray(body.tasks) ? body.tasks : [];

    if (proposed.length === 0 && interactionID) {
      proposed = await loadProposedTasksFromInteraction(interactionID, {
        interactions: deps.interactionStore,
      });
    }

    let accepted;
    try {
      if (proposed.length === 0) {
        const breakdown = await breakdownTask(
          { taskId: parentID },
          { taskStore: deps.taskStore },
        );
        proposed = breakdown.proposed;
      }

      accepted = await acceptBreakdown(parentID, proposed, {
        taskStore: deps.taskStore,
        queue: deps.queue,
      });
    } catch (error) {
      return errorResponse(c, error);
    }

    if (interactionID) {
      const interaction = await deps.interactionStore.get(interactionID);
      if (interaction) {
        await deps.interactionStore.finish(interactionID, {
          status: 'completed',
          qualityJson: JSON.stringify({ proposed, accepted: true }),
        });
      }
    }

    broadcast(deps.sink, 'task.updated', {
      id: parentID,
      status: 'broken_down',
    });

    return c.json({
      data: {
        taskId: parentID,
        interactionId: interactionID,
        created: accepted.createdIds.length,
        taskIds: accepted.createdIds,
        parentId: parentID,
      },
    });
  });

  app.post('/tasks/:id/breakdown/reject', async (c) => {
    const taskID = c.req.param('id');
    const body = await parseBody<BreakdownRejectBody>(c.req);
    const interactionID = body.interactionId?.trim() ?? '';

    await rejectBreakdown(taskID, interactionID, {
      interactions: deps.interactionStore,
    });

    broadcast(deps.sink, 'breakdown.rejected', {
      taskId: taskID,
      interactionId: interactionID,
      rejected: true,
    });

    return c.json({
      data: { taskId: taskID, interactionId: interactionID, rejected: true },
    });
  });
}

function errorResponse(c: Context, error: unknown) {
  const message = safeErrorMessage(error);
  if (message.startsWith('task not found:')) {
    return c.json({ error: 'task not found' }, 404);
  }
  return c.json({ error: message }, 400);
}
