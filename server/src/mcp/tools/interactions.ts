import { z } from 'zod';
import type { InteractionStore } from '../../store/interactions';
import { defineTool } from '../define-tool';
import type { Tool } from '../types';

const requiredTrimmedString = (field: string) =>
  z.preprocess(
    (value) => value ?? '',
    z.coerce.string().trim().min(1, `${field} is required`),
  );

const optionalTrimmedString = () =>
  z.preprocess(
    (value) => (value === undefined ? undefined : (value ?? '')),
    z.coerce.string().trim().optional(),
  );

const interactionsListSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  phase: optionalTrimmedString(),
  status: optionalTrimmedString(),
});

const interactionGetSchema = z.object({
  interactionId: requiredTrimmedString('interactionId'),
});

const taskInteractionsSchema = z.object({
  id: requiredTrimmedString('id'),
  phase: optionalTrimmedString(),
});

export function interactionTools(interactions: InteractionStore): Tool[] {
  return [
    defineTool({
      name: 'interactions_list',
      description: 'List interactions for a task',
      schema: interactionsListSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        const phase = input.phase ?? '';
        const status = input.status ?? '';

        let items = phase
          ? await interactions.listByPhase(taskID, phase)
          : await interactions.list(taskID);
        if (status) {
          items = items.filter((item) => item.status === status);
        }
        return { interactions: items };
      },
    }),
    defineTool({
      name: 'interaction_get',
      description: 'Get one interaction including log content',
      schema: interactionGetSchema,
      handler: async (input) => {
        const interactionID = input.interactionId;
        const interaction = await interactions.get(interactionID);
        if (!interaction)
          throw new Error(`interaction not found: ${interactionID}`);
        const content = await interactions.readLog(interactionID);
        return {
          ...interaction,
          content,
        };
      },
    }),
    // Backward-compatible alias from initial Bun port.
    defineTool({
      name: 'task_interactions',
      description: 'Alias for interactions_list',
      schema: taskInteractionsSchema,
      handler: async (input) => {
        const taskID = input.id;
        const phase = input.phase ?? '';
        return {
          interactions: phase
            ? await interactions.listByPhase(taskID, phase)
            : await interactions.list(taskID),
        };
      },
    }),
  ];
}
