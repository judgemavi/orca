import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ToolPluginRegistry } from '../../plugin/registry';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import type { TaskStore } from '../../store/tasks';
import {
  approvePlan,
  generatePlan,
  requestPlanChanges,
} from '../../workflows/planning';
import type { EventSink } from '../ws';
import { asyncOp } from './async-op';
import { broadcast, parseBody, safeErrorMessage } from './utils';

interface PlanBody {
  plan?: string;
}

interface GeneratePlanBody {
  tool?: string;
  model?: string;
}

interface RequestPlanChangesBody extends GeneratePlanBody {
  feedback?: string;
  interactionId?: string;
}

export interface TaskPlanDeps {
  repoDir: string;
  taskStore: TaskStore;
  interactions: InteractionStore;
  memory: MemoryStore;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
  sink: EventSink;
}

export function taskPlanRoutes(deps: TaskPlanDeps) {
  const {
    repoDir,
    taskStore,
    interactions,
    memory,
    configStore,
    registry,
    sink,
  } = deps;

  return new Hono()
    .get('/tasks/:id/plan', async (c) => {
      const taskID = c.req.param('id');
      return c.json({ plan: await taskStore.getPlan(taskID) });
    })

    .put('/tasks/:id/plan', async (c) => {
      const taskID = c.req.param('id');
      const task = await taskStore.get(taskID);
      if (!task) {
        return c.json({ error: 'task not found' }, 404);
      }
      if (task.status !== 'pending' && task.status !== 'planned') {
        return c.json(
          {
            error: `task ${taskID} is ${task.status}; only pending/planned can update plan`,
          },
          400,
        );
      }

      const body = await parseBody<PlanBody>(c.req);
      await taskStore.setPlan(taskID, body.plan ?? '');
      const updated = await taskStore.get(taskID);
      if (updated) {
        broadcast(sink, 'plan.completed', {
          taskId: taskID,
          plan: updated.plan ?? '',
        });
      }
      return c.json({ plan: body.plan ?? '' });
    })

    .post('/tasks/:id/plan/generate', async (c) => {
      const taskID = c.req.param('id');
      const task = await taskStore.get(taskID);
      if (!task) {
        return c.json({ error: 'task not found' }, 404);
      }

      const body = await parseBody<GeneratePlanBody>(c.req);
      asyncOp(sink, {
        started: {
          name: 'plan.generating',
          payload: { taskId: taskID },
        },
        completed: {
          name: 'plan.completed',
          payload: ({ result }) => ({
            taskId: taskID,
            plan: result.plan,
            interactionId: result.interactionId,
          }),
        },
        failed: {
          name: 'plan.failed',
          payload: ({ error }) => ({
            taskId: taskID,
            error: safeErrorMessage(error),
          }),
        },
        run: async () => {
          const result = await generatePlan(taskID, {
            repoDir,
            taskStore,
            interactions,
            memory,
            configStore,
            registry,
            toolOverride: body.tool ?? '',
            modelOverride: body.model ?? '',
          });
          await taskStore.setPlan(taskID, result.plan);
          return {
            plan: result.plan,
            interactionId: result.interactionId,
          };
        },
      });

      return c.json({ status: 'generating' }, 202);
    })

    .post('/tasks/:id/request-plan-changes', async (c) => {
      const taskID = c.req.param('id');
      const task = await taskStore.get(taskID);
      if (!task) {
        return c.json({ error: 'task not found' }, 404);
      }

      const body = await parseBody<RequestPlanChangesBody>(c.req);
      const feedback = body.feedback?.trim() ?? '';
      if (!feedback) {
        return c.json({ error: 'feedback is required' }, 400);
      }

      asyncOp(sink, {
        completed: {
          name: 'plan.completed',
          payload: ({ result }) => ({
            taskId: taskID,
            plan: result.plan,
            interactionId: result.interactionId,
          }),
        },
        failed: {
          name: 'plan.failed',
          payload: ({ error }) => ({
            taskId: taskID,
            error: safeErrorMessage(error),
          }),
        },
        run: async () => {
          const result = await requestPlanChanges(taskID, feedback, {
            repoDir,
            taskStore,
            interactions,
            memory,
            configStore,
            registry,
            interactionId: body.interactionId ?? '',
            toolOverride: body.tool ?? '',
            modelOverride: body.model ?? '',
          });
          return {
            plan: result.plan,
            interactionId: result.interactionId,
          };
        },
      });

      return c.json({ status: 'generating' }, 202);
    })

    .post('/tasks/:id/approve-plan', async (c) => {
      const taskID = c.req.param('id');
      let updated;
      try {
        updated = await approvePlan(taskID, {
          taskStore,
          requirePendingStatus: true,
        });
      } catch (error) {
        return errorResponse(c, error);
      }

      broadcast(
        sink,
        'task.updated',
        updated as unknown as Record<string, unknown>,
      );
      return c.json(updated);
    });
}

function errorResponse(c: Context, error: unknown) {
  const message = safeErrorMessage(error);
  if (message.startsWith('task not found:')) {
    return c.json({ error: 'task not found' }, 404);
  }
  return c.json({ error: message }, 400);
}
