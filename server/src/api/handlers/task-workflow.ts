import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Executor } from '../../executor/executor';
import type { ToolPluginRegistry } from '../../plugin/registry';
import { resumeChain } from '../../queue/chain';
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
import {
  aiReviewSchema,
  breakdownAcceptSchema,
  breakdownRejectSchema,
  provideInputSchema,
  requestChangesSchema,
  toolModelSchema,
} from '../schemas';
import type { EventSink } from '../ws';
import { broadcast, safeErrorMessage } from './utils';

export function taskWorkflowRoutes(deps: {
  repoDir: string;
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
  executor: Executor;
  sink: EventSink;
  queue: JobQueue;
}) {
  return new Hono()
    .post('/tasks/:id/approve', async (c) => {
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
      await resumeChain(taskID, 'approved', {
        configStore: deps.configStore,
        taskStore: deps.taskStore,
        queue: deps.queue,
      });
      return c.json(updated);
    })

    .post(
      '/tasks/:id/request-changes',
      zValidator('json', requestChangesSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const task = await deps.taskStore.get(taskID);
        if (!task) return c.json({ error: 'task not found' }, 404);
        if (task.status !== 'review') {
          return c.json(
            { error: 'task must be in review status to request changes' },
            400,
          );
        }

        const body = c.req.valid('json');
        const feedback = body.feedback?.trim() ?? '';
        if (!feedback) {
          return c.json({ error: 'feedback is required' }, 400);
        }

        const tool = body.tool ?? '';
        const model = body.model ?? '';
        const interactionId = body.interactionId ?? '';

        await deps.taskStore.addReview(taskID, feedback, interactionId);
        await deps.interactionStore.supersedeReviewInteractions(taskID);

        const { id: jobId } = await deps.queue.enqueue({
          type: 'code',
          taskId: taskID,
          priority: JOB_PRIORITIES.code,
          payload: { tool, model },
        });

        return c.json({ status: 'queued', taskId: taskID, jobId }, 202);
      },
    )

    .post(
      '/tasks/:id/ai-review',
      zValidator('json', aiReviewSchema),
      async (c) => {
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

        const body = c.req.valid('json');
        const runInteractions = await deps.interactionStore.listByType(
          taskID,
          'code',
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

        return c.json({ status: 'queued', taskId: taskID, jobId }, 202);
      },
    )

    .post(
      '/tasks/:id/evaluate',
      zValidator('json', toolModelSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        const { id: jobId } = await deps.queue.enqueue({
          type: 'evaluate',
          taskId: taskID,
          priority: JOB_PRIORITIES.evaluate,
          payload: { tool: body.tool ?? '', model: body.model ?? '' },
        });

        broadcast(deps.sink, 'evaluate.started', { taskId: taskID });
        return c.json({ taskId: taskID, jobId, status: 'queued' }, 202);
      },
    )

    .post(
      '/tasks/:id/breakdown',
      zValidator('json', toolModelSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const task = await deps.taskStore.get(taskID);
        if (!task) return c.json({ error: 'task not found' }, 404);

        const body = c.req.valid('json');

        const { id: jobId } = await deps.queue.enqueue({
          type: 'breakdown',
          taskId: taskID,
          priority: JOB_PRIORITIES.breakdown,
          payload: { tool: body.tool ?? '', model: body.model ?? '' },
        });

        return c.json({ taskId: taskID, jobId, status: 'queued' }, 202);
      },
    )

    .post(
      '/tasks/:id/breakdown/accept',
      zValidator('json', breakdownAcceptSchema),
      async (c) => {
        const parentID = c.req.param('id');

        const body = c.req.valid('json');
        const interactionID = body.interactionId?.trim() ?? '';
        let proposed: ProposedTask[] = Array.isArray(body.tasks)
          ? (body.tasks as ProposedTask[])
          : [];

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
          taskId: parentID,
          interactionId: interactionID,
          created: accepted.createdIds.length,
          taskIds: accepted.createdIds,
          parentId: parentID,
        });
      },
    )

    .post(
      '/tasks/:id/input',
      zValidator('json', provideInputSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const task = await deps.taskStore.get(taskID);
        if (!task) return c.json({ error: 'task not found' }, 404);
        if (!task.pendingQuestion) {
          return c.json({ error: 'task has no pending question' }, 400);
        }

        const body = c.req.valid('json');
        const answer = body.answer.trim();

        const updatedDescription = task.description
          ? `${task.description}\n\n---\n**User clarification:** ${answer}`
          : `**User clarification:** ${answer}`;

        await deps.taskStore.update(taskID, {
          description: updatedDescription,
          pendingQuestion: null,
          status: 'pending',
        });

        const { id: jobId } = await deps.queue.enqueue({
          type: 'evaluate',
          taskId: taskID,
          priority: JOB_PRIORITIES.evaluate,
        });

        broadcast(deps.sink, 'task.updated', {
          id: taskID,
          status: 'pending',
        });

        return c.json({ taskId: taskID, jobId, status: 'queued' }, 202);
      },
    )

    .post(
      '/tasks/:id/breakdown/reject',
      zValidator('json', breakdownRejectSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');
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
          taskId: taskID,
          interactionId: interactionID,
          rejected: true,
        });
      },
    );
}

function errorResponse(c: Context, error: unknown) {
  const message = safeErrorMessage(error);
  if (message.startsWith('task not found:')) {
    return c.json({ error: 'task not found' }, 404);
  }
  return c.json({ error: message }, 400);
}
