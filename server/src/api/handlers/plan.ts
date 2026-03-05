import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import {
  acceptBreakdown,
  breakdownTask,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
} from '../../workflows/planning';
import {
  planAcceptSchema,
  planRejectSchema,
  planRequestSchema,
} from '../schemas';
import type { EventSink } from '../ws';
import { broadcast } from './utils';

export function planRoutes(deps: {
  taskStore: TaskStore;
  interactions: InteractionStore;
  sink: EventSink;
}) {
  return new Hono()
    .post('/plan', zValidator('json', planRequestSchema), async (c) => {
      const body = c.req.valid('json');
      const goal = body.goal?.trim() ?? '';
      if (!goal) {
        return c.json({ error: 'goal is required' }, 400);
      }

      const interaction = await deps.interactions.begin({
        taskId: null,
        type: 'breakdown',
        tool: body.tool || 'planner',
      });

      const breakdown = await breakdownTask(
        { goal },
        { taskStore: deps.taskStore },
      );
      const proposed = breakdown.proposed;
      await deps.interactions.finish(interaction.id, {
        status: 'completed',
        qualityJson: JSON.stringify({ goal, proposed }),
      });

      broadcast(deps.sink, 'breakdown.completed', {
        operationId: interaction.id,
        sessionId: body.sessionId ?? '',
        proposed,
      });

      return c.json(
        { status: 'breaking_down', operationId: interaction.id },
        202,
      );
    })

    .post('/plan/accept', zValidator('json', planAcceptSchema), async (c) => {
      const body = c.req.valid('json');

      let proposed = body.tasks ?? [];
      if (proposed.length === 0 && body.operationId?.trim()) {
        proposed = await loadProposedTasksFromInteraction(body.operationId, {
          interactions: deps.interactions,
        });
      }

      const accepted = await acceptBreakdown(null, proposed, {
        taskStore: deps.taskStore,
      });

      return c.json({
        created: accepted.createdIds.length,
        taskIds: accepted.createdIds,
        operationId: body.operationId ?? '',
      });
    })

    .post('/plan/reject', zValidator('json', planRejectSchema), async (c) => {
      const body = c.req.valid('json');
      await rejectBreakdown('', body.operationId ?? '', {
        interactions: deps.interactions,
      });
      return c.json({
        rejected: true,
        operationId: body.operationId ?? '',
      });
    });
}
