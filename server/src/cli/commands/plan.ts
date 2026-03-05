import type { Command } from 'commander';
import {
  availableTools,
  type ToolPluginRegistry,
  toolModels,
} from '../../plugin/registry';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import {
  acceptBreakdown,
  breakdownTask,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
} from '../../workflows/planning';
import { printJSON } from '../format';
import { pickFromList, textInput } from '../helpers';

export function registerPlanCommands(
  program: Command,
  deps: {
    taskStore: TaskStore;
    interactionStore: InteractionStore;
    registry: ToolPluginRegistry;
  },
) {
  const plan = program.command('plan').description('Global planning workflow');

  plan
    .command('create')
    .option('--goal <goal>', 'planning goal')
    .option('--tool <tool>', 'tool name')
    .option('--model <model>', 'model name')
    .action(async (opts: { goal?: string; tool?: string; model?: string }) => {
      let goal = (opts.goal ?? '').trim();
      if (!goal) {
        if (!canPrompt())
          throw new Error('--goal is required in non-interactive mode');
        goal = await textInput('Planning goal', { required: true });
      }

      const tools = availableTools(deps.registry);
      const tool = (opts.tool ?? '').trim() || (await resolveTool(tools));
      const models = toolModels(deps.registry, tool);
      const model =
        (opts.model ?? '').trim() || (await resolveModel(tool, models));

      const breakdown = await breakdownTask(
        { goal },
        { taskStore: deps.taskStore },
      );
      const proposed = breakdown.proposed;
      const interaction = await deps.interactionStore.begin({
        taskId: null,
        type: 'breakdown',
        tool,
      });
      await deps.interactionStore.finish(interaction.id, {
        status: 'completed',
        model,
        qualityJson: JSON.stringify({ goal, proposed, tool, model }),
      });
      printJSON({
        status: 'breaking_down',
        operationId: interaction.id,
        tool,
        model,
        proposed,
      });
    });

  plan
    .command('accept')
    .option('--operation <id>', 'operation interaction id')
    .action(async (opts: { operation?: string }) => {
      const operationID = await resolveOperationID(
        opts.operation,
        deps.interactionStore,
      );
      const proposed = await loadProposedTasksFromInteraction(operationID, {
        interactions: deps.interactionStore,
      });
      const accepted = await acceptBreakdown(null, proposed, {
        taskStore: deps.taskStore,
      });
      printJSON({
        created: accepted.createdIds.length,
        taskIds: accepted.createdIds,
        operationId: operationID,
      });
    });

  plan
    .command('reject')
    .option('--operation <id>', 'operation interaction id')
    .action(async (opts: { operation?: string }) => {
      const operationID = await resolveOperationID(
        opts.operation,
        deps.interactionStore,
      );
      await rejectBreakdown('', operationID, {
        interactions: deps.interactionStore,
      });
      printJSON({ rejected: true, operationId: operationID });
    });
}

async function resolveOperationID(
  operationID: string | undefined,
  interactionStore: InteractionStore,
): Promise<string> {
  const explicit = (operationID ?? '').trim();
  if (explicit) return explicit;
  if (!canPrompt()) {
    throw new Error('--operation is required in non-interactive mode');
  }

  const operations = await interactionStore.listProjectByType('breakdown');
  if (operations.length === 0) {
    throw new Error('no recent plan operations found');
  }

  return pickFromList(
    'Select plan operation',
    operations.slice(0, 20).map((item) => ({
      label: `${item.id.slice(0, 8)}  ${item.status}  ${item.startedAt}`,
      value: item.id,
    })),
    operations[0]?.id,
  );
}

async function resolveTool(tools: string[]): Promise<string> {
  if (tools.length === 0) return 'planner';
  if (!canPrompt()) return tools[0] as string;
  return pickFromList(
    'Planning tool',
    tools.map((tool) => ({ label: tool, value: tool })),
    tools[0] as string,
  );
}

async function resolveModel(tool: string, models: string[]): Promise<string> {
  if (models.length === 0) return '';
  if (!canPrompt()) return models[0] as string;
  return pickFromList(
    `Planning model (${tool})`,
    models.map((model) => ({ label: model, value: model })),
    models[0] as string,
  );
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json');
}
