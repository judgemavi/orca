import type { Command } from 'commander';
import type { ToolPluginRegistry } from '../../plugin/registry';
import type { Executor } from '../../executor/executor';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import {
  approveTask,
  requestChanges,
  runAIReviewWorkflow,
} from '../../workflows/review';
import { printJSON } from '../format';
import { pickTask, reviewTasks, textInput } from '../helpers';

export function registerReviewCommands(
  program: Command,
  deps: {
    repoDir: string;
    taskStore: TaskStore;
    interactionStore: InteractionStore;
    configStore: ConfigStore;
    registry: ToolPluginRegistry;
    executor: Executor;
  },
) {
  const review = program.command('review').description('Review commands');

  review.command('approve [id]').action(async (id?: string) => {
    const taskID = await resolveReviewTaskID(deps.taskStore, id);
    const updated = await approveTask(taskID, { taskStore: deps.taskStore });
    printJSON(updated);
  });

  review
    .command('request-changes [id]')
    .option('--feedback <feedback>', 'review feedback')
    .action(async (id: string | undefined, opts: { feedback?: string }) => {
      const taskID = await resolveReviewTaskID(deps.taskStore, id);
      let feedback = (opts.feedback ?? '').trim();
      if (!feedback) {
        if (!canPrompt()) {
          throw new Error('--feedback is required in non-interactive mode');
        }
        feedback = await textInput('Review feedback', { required: true });
      }
      const result = await requestChanges(taskID, feedback, {
        taskStore: deps.taskStore,
        interactions: deps.interactionStore,
        executor: deps.executor,
      });
      printJSON(result);
    });

  review
    .command('ai [id]')
    .option('--tool <tool>', 'review tool')
    .option('--model <model>', 'review model')
    .option('--prompt <prompt>', 'additional review instructions')
    .action(
      async (
        id: string | undefined,
        opts: { tool?: string; model?: string; prompt?: string },
      ) => {
        const taskID = await resolveReviewTaskID(deps.taskStore, id);
        const result = await runAIReviewWorkflow(taskID, {
          repoDir: deps.repoDir,
          configStore: deps.configStore,
          registry: deps.registry,
          taskStore: deps.taskStore,
          interactions: deps.interactionStore,
          prompt: opts.prompt ?? '',
          toolOverride: opts.tool ?? '',
          modelOverride: opts.model ?? '',
        });

        printJSON(result);
      },
    );
}

async function resolveReviewTaskID(
  taskStore: TaskStore,
  id?: string,
): Promise<string> {
  const explicit = (id ?? '').trim();
  if (explicit) return explicit;
  if (!canPrompt()) {
    throw new Error('task id required in non-interactive mode');
  }
  const task = await pickTask(taskStore, 'Select review task', reviewTasks);
  return task.id;
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json');
}
