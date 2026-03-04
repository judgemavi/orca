import type { Hono } from 'hono';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import type { ProposedTask } from '../../types';
import {
  acceptBreakdown,
  breakdownTask,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
} from '../../workflows/planning';
import type { EventSink } from '../ws';
import { broadcast, parseBody } from './utils';

interface PlanRequestBody {
  goal?: string;
  tool?: string;
  sessionId?: string;
}

interface PlanAcceptBody {
  operationId?: string;
  sessionId?: string;
  tasks?: ProposedTask[];
}

interface PlanRejectBody {
  operationId?: string;
  sessionId?: string;
}

export function registerPlanHandlers(
  app: Hono,
  deps: {
    taskStore: TaskStore;
    interactions: InteractionStore;
    sink: EventSink;
  },
) {
  app.post('/plan', async (c) => {
    const body = await parseBody<PlanRequestBody>(c.req);
    const goal = body.goal?.trim() ?? '';
    if (!goal) {
      return c.json({ error: 'goal is required' }, 400);
    }

    const interaction = await deps.interactions.begin({
      taskId: null,
      phase: 'breakdown',
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
      { data: { status: 'breaking_down', operationId: interaction.id } },
      202,
    );
  });

  app.post('/plan/accept', async (c) => {
    const body = await parseBody<PlanAcceptBody>(c.req);

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
      data: {
        created: accepted.createdIds.length,
        taskIds: accepted.createdIds,
        operationId: body.operationId ?? '',
      },
    });
  });

  app.post('/plan/reject', async (c) => {
    const body = await parseBody<PlanRejectBody>(c.req);
    await rejectBreakdown('', body.operationId ?? '', {
      interactions: deps.interactions,
    });
    return c.json({
      data: {
        rejected: true,
        operationId: body.operationId ?? '',
      },
    });
  });
}
