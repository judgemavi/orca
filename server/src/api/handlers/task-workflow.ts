import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { JobQueue } from '../../queue/queue';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import type { ProposedTask } from '../../types';
import {
  acceptBreakdown,
  breakdownTask,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
} from '../../workflows/planning';
import { approveTask } from '../../workflows/review';
import {
  enqueueBreakdown,
  enqueueEvaluate,
  provideInput,
  requestChanges,
  triggerReview,
} from '../../workflows/tasks';
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
  sink: EventSink;
  queue: JobQueue;
}) {
  return new Hono()
    .post('/tasks/:id/approve', async (c) => {
      const taskID = c.req.param('id');
      let updated: Awaited<ReturnType<typeof approveTask>>;
      try {
        updated = await approveTask(taskID, {
          taskStore: deps.taskStore,
          queue: deps.queue,
          configStore: deps.configStore,
        });
      } catch (error) {
        return errorResponse(c, error);
      }
      broadcast(
        deps.sink,
        'task.updated',
        updated as unknown as Record<string, unknown>,
      );
      return c.json(updated);
    })

    .post(
      '/tasks/:id/request-changes',
      zValidator('json', requestChangesSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        try {
          const result = await requestChanges(taskID, body.feedback ?? '', {
            taskStore: deps.taskStore,
            interactionStore: deps.interactionStore,
            queue: deps.queue,
            interactionId: body.interactionId,
            tool: body.tool,
            model: body.model,
          });
          return c.json(
            { status: 'queued', taskId: result.taskId, jobId: result.jobId },
            202,
          );
        } catch (error) {
          return errorResponse(c, error);
        }
      },
    )

    .post(
      '/tasks/:id/ai-review',
      zValidator('json', aiReviewSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        try {
          const result = await triggerReview(
            taskID,
            {
              prompt: body.prompt,
              tool: body.tool,
              model: body.model,
            },
            {
              taskStore: deps.taskStore,
              interactionStore: deps.interactionStore,
              queue: deps.queue,
            },
          );
          return c.json(
            { status: 'queued', taskId: result.taskId, jobId: result.jobId },
            202,
          );
        } catch (error) {
          return errorResponse(c, error);
        }
      },
    )

    .post(
      '/tasks/:id/evaluate',
      zValidator('json', toolModelSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        const result = await enqueueEvaluate(
          taskID,
          { tool: body.tool, model: body.model },
          { taskStore: deps.taskStore, queue: deps.queue },
        );

        broadcast(deps.sink, 'evaluate.started', { taskId: taskID });
        return c.json({ ...result, status: 'queued' }, 202);
      },
    )

    .post(
      '/tasks/:id/breakdown',
      zValidator('json', toolModelSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        try {
          const result = await enqueueBreakdown(
            taskID,
            { tool: body.tool, model: body.model },
            { taskStore: deps.taskStore, queue: deps.queue },
          );
          return c.json({ ...result, status: 'queued' }, 202);
        } catch (error) {
          return errorResponse(c, error);
        }
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

        let accepted: Awaited<ReturnType<typeof acceptBreakdown>>;
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
        const body = c.req.valid('json');

        try {
          const result = await provideInput(taskID, body.answer, {
            taskStore: deps.taskStore,
            queue: deps.queue,
          });

          broadcast(deps.sink, 'task.updated', {
            id: taskID,
            status: 'pending',
          });

          return c.json(
            { taskId: result.taskId, jobId: result.jobId, status: 'queued' },
            202,
          );
        } catch (error) {
          return errorResponse(c, error);
        }
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
