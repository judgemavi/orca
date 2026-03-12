import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import type { JobQueue } from '../../queue/queue';
import { provideInputSchema } from '../../schemas/tasks';
import {
  breakdownAcceptSchema,
  breakdownRejectSchema,
  completeStepSchema,
  enqueueStepSchema,
  manualStepSchema,
  requestChangesSchema,
  resetSchema,
  toolModelSchema,
  updateInteractionOutputSchema,
} from '../../schemas/workflow';
import { toErrorMessage } from '../../shared/errors';
import type { InteractionStore } from '../../store/interactions';
import * as questionStore from '../../store/questions';
import * as taskStore from '../../store/tasks';
import type { ProposedTask } from '../../types/api';
import { getStepOutput, hasStepOutput } from '../../workflow/context';
import { completeStep, resolveStepMeta } from '../../workflow/engine';
import {
  parseWorkflowOutput,
  stringifyWorkflowOutput,
} from '../../workflow/output';
import type { AnyStateNode } from '../../workflow/paths';
import { getTransitionEvents } from '../../workflow/paths';
import {
  createSyntheticStepInteraction,
  loadCurrentTaskStep,
} from '../../workflow/step-actions';
import type { WorkflowStore } from '../../workflow/store';
import type { StepMeta } from '../../workflow/types';
import {
  acceptBreakdown,
  breakdownTask,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
} from '../../workflows/planning';
import { resetToStep } from '../../workflows/rewind';
import {
  enqueueBreakdown,
  enqueueCurrentStep,
  enqueueEvaluate,
  provideInput,
} from '../../workflows/tasks';
import type { EventSink } from '../ws';
import { broadcast } from './utils';

export function taskWorkflowRoutes(deps: {
  repoDir: string;
  db: OrcaDrizzleDB;
  interactionStore: InteractionStore;
  sink: EventSink;
  queue: JobQueue;
  workflowStore: WorkflowStore;
}) {
  const { db, sink } = deps;

  return new Hono()
    .get('/tasks/:id/workflow/steps', async (c) => {
      const taskID = c.req.param('id');
      const task = await taskStore.getTask(db, taskID).catch(() => null);
      if (!task) return c.json({ error: 'task not found' }, 404);

      const compiled = await deps.workflowStore.resolve(
        task.workflow ?? undefined,
      );

      type StepInfo = {
        type: string;
        executor: string | null;
        steps?: Record<string, StepInfo>;
      };

      function mapNode(node: AnyStateNode): Record<string, StepInfo> {
        const out: Record<string, StepInfo> = {};
        for (const [name, child] of Object.entries(node.states ?? {})) {
          if (child.type === 'final') continue;
          const meta = (child.meta ?? {}) as StepMeta;
          const hasChildren =
            child.states &&
            Object.keys(child.states).filter(
              (k) => child.states![k]?.type !== 'final',
            ).length > 0;
          out[name] = {
            type: meta.type ?? 'unknown',
            executor: meta.executor ?? null,
            ...(hasChildren ? { steps: mapNode(child) } : {}),
          };
        }
        return out;
      }

      return c.json({
        workflow: compiled.name,
        steps: mapNode(compiled.machine.root as unknown as AnyStateNode),
      });
    })

    .get('/tasks/:id/step/current', async (c) => {
      const taskID = c.req.param('id');
      const task = await taskStore.getTask(db, taskID).catch(() => null);
      if (!task) return c.json({ error: 'task not found' }, 404);
      if (!task.currentStep) return c.json({ step: null });

      const compiled = await deps.workflowStore.resolve(
        task.workflow ?? undefined,
      );
      let stepMeta: StepMeta;
      let stateNode: AnyStateNode;
      try {
        const resolved = resolveStepMeta(compiled.machine, task.currentStep);
        stepMeta = resolved.meta;
        stateNode = resolved.stateNode;
      } catch {
        return c.json({ step: null });
      }

      const branchNames = getTransitionEvents(stateNode);
      return c.json({
        step: {
          name: task.currentStep,
          type: stepMeta.type,
          executor: stepMeta.executor ?? null,
          branches: branchNames.map((name) => ({
            name,
            includeOutput:
              compiled.transitionMeta[`${task.currentStep}:${name}`]
                ?.includeOutput ?? false,
          })),
        },
      });
    })

    .get('/tasks/:id/step/:step/output', async (c) => {
      const taskID = c.req.param('id');
      const stepName = c.req.param('step');
      const output = await getStepOutput(
        taskID,
        stepName,
        deps.interactionStore,
      );
      return c.json({ taskId: taskID, stepName, output });
    })

    .post('/tasks/:id/approve', async (c) => {
      const taskID = c.req.param('id');
      try {
        await assertNoRunningInteraction(taskID, deps.interactionStore);
        const task = await taskStore.getTask(db, taskID).catch(() => {
          throw new Error(`task not found: ${taskID}`);
        });
        if (!task.currentStep) throw new Error('task has no current step');

        const has = await hasStepOutput(
          taskID,
          task.currentStep,
          deps.interactionStore,
        );
        if (!has) {
          throw new Error(`no completed output for step "${task.currentStep}"`);
        }

        const compiled = await deps.workflowStore.resolve(
          task.workflow ?? undefined,
        );
        let branchNames: string[] = [];
        try {
          const resolved = resolveStepMeta(compiled.machine, task.currentStep);
          branchNames = getTransitionEvents(resolved.stateNode);
        } catch {
          branchNames = [];
        }
        const outcome = branchNames.includes('approved')
          ? 'approved'
          : (branchNames[0] ?? 'done');

        const result = await completeStep(taskID, outcome, {
          db,
          queue: deps.queue,
          workflowStore: deps.workflowStore,
        });
        broadcast(sink, 'task.updated', { id: taskID });
        return c.json({ taskId: taskID, ...result });
      } catch (error) {
        return errorResponse(c, error);
      }
    })

    .post(
      '/tasks/:id/request-changes',
      zValidator('json', requestChangesSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        try {
          await assertNoRunningInteraction(taskID, deps.interactionStore);
          const feedback = (body.feedback ?? '').trim();
          if (!feedback) throw new Error('feedback is required');

          const task = await taskStore.getTask(db, taskID).catch(() => {
            throw new Error(`task not found: ${taskID}`);
          });
          if (!task.currentStep) throw new Error('task has no no current step');

          await deps.interactionStore.supersedeReviewInteractions(taskID);

          const result = await completeStep(
            taskID,
            'request_changes',
            { db, queue: deps.queue, workflowStore: deps.workflowStore },
            {
              output: feedback,
              tool: body.tool ?? '',
              model: body.model ?? '',
            },
          );
          return c.json({ taskId: taskID, ...result }, 202);
        } catch (error) {
          return errorResponse(c, error);
        }
      },
    )

    .post(
      '/tasks/:id/step/run',
      zValidator('json', enqueueStepSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        try {
          const result = await enqueueCurrentStep(
            taskID,
            {
              tool: body.tool ?? '',
              model: body.model ?? '',
            },
            { db, sink, queue: deps.queue },
          );
          return c.json({ ...result, status: 'queued' }, 202);
        } catch (error) {
          return errorResponse(c, error);
        }
      },
    )

    .post(
      '/tasks/:id/step/manual',
      zValidator('json', manualStepSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        try {
          await assertNoRunningInteraction(taskID, deps.interactionStore);
          const { currentStep, step, stateNode } = await loadCurrentTaskStep(
            taskID,
            {
              db,
              workflowStore: deps.workflowStore,
            },
          );
          if (step.type !== 'context' && step.type !== 'decision') {
            return c.json(
              {
                error: `step "${currentStep}" does not support manual entry`,
              },
              400,
            );
          }

          const ix = await deps.interactionStore.begin({
            taskId: taskID,
            type: currentStep,
            tool: 'manual',
          });

          const branchNames = stateNode ? getTransitionEvents(stateNode) : [];
          const outcome = body.outcome ?? branchNames[0] ?? 'done';
          await deps.interactionStore.finish(ix.id, {
            status: 'completed',
            output: stringifyWorkflowOutput({
              result: outcome,
              output: body.output,
            }),
            durationMs: 0,
          });
          const result = await completeStep(taskID, outcome, {
            db,
            queue: deps.queue,
            workflowStore: deps.workflowStore,
          });

          broadcast(sink, 'task.updated', { id: taskID });
          return c.json({
            taskId: taskID,
            interactionId: ix.id,
            step: currentStep,
            outcome,
            ...result,
          });
        } catch (error) {
          return errorResponse(c, error);
        }
      },
    )

    .patch(
      '/tasks/:id/interactions/:interactionId/output',
      zValidator('json', updateInteractionOutputSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const interactionID = c.req.param('interactionId');
        const body = c.req.valid('json');

        try {
          const interaction = await deps.interactionStore.get(interactionID);
          if (!interaction)
            return c.json({ error: 'interaction not found' }, 404);
          if (interaction.taskId !== taskID) {
            return c.json(
              { error: 'interaction does not belong to task' },
              400,
            );
          }

          const parsed =
            parseWorkflowOutput(interaction.output) ??
            ({ result: 'done', output: '', data: {} } as const);
          const output = body.output.trim();
          const nextData = { ...parsed.data, output };

          await deps.interactionStore.updateOutput(
            interactionID,
            stringifyWorkflowOutput({
              result: parsed.result ?? 'done',
              output,
              data: nextData,
            }),
          );

          broadcast(sink, 'interaction.updated', {
            id: interactionID,
            taskId: taskID,
          });
          return c.json({
            taskId: taskID,
            interactionId: interactionID,
            updated: true,
          });
        } catch (error) {
          return errorResponse(c, error);
        }
      },
    )

    .post(
      '/tasks/:id/step/complete',
      zValidator('json', completeStepSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        try {
          await assertNoRunningInteraction(taskID, deps.interactionStore);
          const { currentStep, step: stepMeta } = await loadCurrentTaskStep(
            taskID,
            {
              db,
              workflowStore: deps.workflowStore,
            },
          );
          if (stepMeta?.type !== 'decision') {
            const has = await hasStepOutput(
              taskID,
              currentStep,
              deps.interactionStore,
            );
            if (!has) {
              return c.json(
                { error: `no completed output for step "${currentStep}"` },
                400,
              );
            }
          }

          if (stepMeta?.type === 'decision') {
            const has = await hasStepOutput(
              taskID,
              currentStep,
              deps.interactionStore,
            );
            if (!has) {
              await createSyntheticStepInteraction(deps.interactionStore, {
                taskId: taskID,
                stepName: currentStep,
                outcome: body.outcome,
                output: body.output ?? '',
                data: body.data,
              });
            }
          }

          const result = await completeStep(
            taskID,
            body.outcome,
            {
              db,
              queue: deps.queue,
              workflowStore: deps.workflowStore,
            },
            body.output ? { output: body.output } : undefined,
          );

          broadcast(sink, 'task.updated', { id: taskID });
          return c.json({
            taskId: taskID,
            outcome: body.outcome,
            ...result,
          });
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
          { db, sink, queue: deps.queue },
        );

        broadcast(sink, 'evaluate.started', { taskId: taskID });
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
            { db, sink, queue: deps.queue },
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
            const breakdown = await breakdownTask({ taskId: parentID }, { db });
            proposed = breakdown.proposed;
          }

          accepted = await acceptBreakdown(parentID, proposed, {
            db,
            sink,
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
              output: JSON.stringify({
                result: 'accepted',
                data: { proposed, accepted: true },
              }),
            });
          }
        }

        broadcast(sink, 'task.updated', {
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

    .get('/tasks/:id/questions/pending', async (c) => {
      const taskID = c.req.param('id');
      const question = await questionStore.getPendingForTask(db, taskID);
      if (!question) return c.json(null, 200);
      return c.json(question, 200);
    })

    .post(
      '/tasks/:id/input',
      zValidator('json', provideInputSchema),
      async (c) => {
        const taskID = c.req.param('id');
        const body = c.req.valid('json');

        try {
          const result = await provideInput(taskID, body.answer, {
            db,
            sink,
            queue: deps.queue,
            workflowStore: deps.workflowStore,
            interactionStore: deps.interactionStore,
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

        broadcast(sink, 'breakdown.rejected', {
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
    )

    .post('/tasks/:id/reset', zValidator('json', resetSchema), async (c) => {
      const taskID = c.req.param('id');
      const body = c.req.valid('json');

      try {
        const result = await resetToStep(
          {
            taskId: taskID,
            interactionId: body.interactionId,
            enqueue: body.enqueue,
          },
          {
            interactionStore: deps.interactionStore,
            queue: deps.queue,
            repoDir: deps.repoDir,
            db,
          },
        );
        broadcast(sink, 'task.updated', { id: taskID });
        return c.json(result);
      } catch (error) {
        return errorResponse(c, error);
      }
    });
}

async function assertNoRunningInteraction(
  taskID: string,
  interactionStore: InteractionStore,
) {
  if (await interactionStore.hasRunningForTask(taskID)) {
    throw new Error(
      'a step is currently running for this task — wait for it to complete before taking action',
    );
  }
}

function errorResponse(c: Context, error: unknown) {
  const message = toErrorMessage(error);
  if (message.startsWith('task not found:')) {
    return c.json({ error: 'task not found' }, 404);
  }
  return c.json({ error: message }, 400);
}
