import { Command } from 'commander';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { Executor } from '../executor/executor';
import type { JobQueue } from '../queue/queue';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import { registerConfigCommands } from './commands/config';
import { registerCostsCommand } from './commands/costs';
import { registerExploreCommands } from './commands/explore';
import { registerMemoryCommands } from './commands/memory';
import { registerMergeCommands } from './commands/merge';
import { registerModelsCommand } from './commands/models';
import { registerOpsCommand } from './commands/ops';
import { registerOrcCommand } from './commands/orc';
import { registerPlanCommands } from './commands/plan';
import { registerQueueCommands } from './commands/queue';
import { registerReviewCommands } from './commands/review';
import { registerStatusCommand } from './commands/status';
import { registerTaskCommands } from './commands/task';
import { printJSON, setJSONMode } from './format';
import { confirm } from './helpers';

export async function runCLI(deps: {
  repoDir: string;
  configStore: ConfigStore;
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  registry: ToolPluginRegistry;
  executor: Executor;
  queue?: JobQueue;
}) {
  const program = new Command();

  program.name('orca-ts').description('Bun-based Orca CLI').version('0.1.0');
  program.option('--json', 'output raw JSON');
  setJSONMode(Bun.argv.includes('--json'));

  // init is handled in index.ts before bootstrap — this is a no-op so commander doesn't error on unknown command
  program
    .command('init')
    .description('Initialize orca workspace (handled at startup)')
    .action(() => {});

  program
    .command('start')
    .description('Start pending tasks or specific task IDs')
    .argument('[taskIds...]', 'task IDs')
    .option('--tool <tool>', 'tool override')
    .option('--model <model>', 'model override')
    .option('--context <context>', 'context prompt')
    .action(
      async (
        taskIDs: string[],
        opts: { tool?: string; model?: string; context?: string },
      ) => {
        if (taskIDs.length > 0) {
          await deps.executor.runBatch(taskIDs, {
            toolOverride: opts.tool ?? '',
            modelOverride: opts.model ?? '',
            context: opts.context ?? '',
          });
          printJSON({ status: 'queued', taskIds: taskIDs });
          return;
        }

        if (canPrompt()) {
          const proceed = await confirm(
            'Start all ready pending/planned tasks?',
            true,
          );
          if (!proceed) {
            printJSON({ started: false });
            return;
          }
        }
        await deps.executor.runPendingTasks();
        printJSON({ status: 'queued' });
      },
    );

  program
    .command('logs')
    .option('--interaction <id>', 'interaction id')
    .option('--task <id>', 'task id, prints most recent interaction log')
    .option('--type <type>', 'filter by interaction type')
    .option('--json', 'raw JSON output')
    .action(
      async (opts: {
        interaction?: string;
        task?: string;
        type?: string;
        json?: boolean;
      }) => {
        const interactionID = (opts.interaction ?? '').trim();
        const taskID = (opts.task ?? '').trim();
        const type = (opts.type ?? '').trim();

        if (interactionID) {
          if (opts.json) {
            const interaction = await deps.interactionStore.get(interactionID);
            console.log(JSON.stringify(interaction, null, 2));
            return;
          }
          const content = await deps.interactionStore.readLog(interactionID);
          console.log(content);
          return;
        }

        if (taskID) {
          const interactions = type
            ? await deps.interactionStore.listByType(taskID, type)
            : await deps.interactionStore.list(taskID);
          if (interactions.length === 0) {
            throw new Error(
              `no interactions for task ${taskID}${type ? ` type=${type}` : ''}`,
            );
          }
          if (opts.json) {
            console.log(JSON.stringify(interactions, null, 2));
            return;
          }
          const content = await deps.interactionStore.readLog(
            interactions[0].id,
          );
          console.log(content);
          return;
        }

        if (type) {
          const interactions =
            await deps.interactionStore.listProjectByType(type);
          if (opts.json) {
            console.log(JSON.stringify(interactions, null, 2));
            return;
          }
          if (interactions.length === 0) {
            throw new Error(`no interactions for type ${type}`);
          }
          const content = await deps.interactionStore.readLog(
            interactions[0].id,
          );
          console.log(content);
          return;
        }

        throw new Error(
          'provide --interaction <id>, --task <id>, or --type <type>',
        );
      },
    );

  program
    .command('cleanup')
    .option('--task <id>', 'task id')
    .action(async (opts: { task?: string }) => {
      const taskID = (opts.task ?? '').trim();
      if (taskID) {
        if (canPrompt()) {
          const proceed = await confirm(
            `Remove logs for task ${taskID}?`,
            false,
          );
          if (!proceed) {
            printJSON({ removed: 0, taskId: taskID, cancelled: true });
            return;
          }
        }
        await deps.interactionStore.removeTaskLogs(taskID);
        printJSON({ removed: 1, taskId: taskID });
        return;
      }

      const failed = await deps.taskStore.listByStatus('failed');
      if (canPrompt()) {
        const proceed = await confirm(
          `Remove logs for ${failed.length} failed task(s)?`,
          failed.length > 0,
        );
        if (!proceed) {
          printJSON({ removed: 0, cancelled: true });
          return;
        }
      }
      for (const task of failed) {
        await deps.interactionStore.removeTaskLogs(task.id);
      }
      printJSON({ removed: failed.length });
    });

  const context = program
    .command('context')
    .description('Explore context file operations');
  context.command('get').action(async () => {
    const path = `${deps.repoDir}/.orca/explore_context.md`;
    const content = await Bun.file(path)
      .text()
      .catch(() => '');
    console.log(content);
  });
  context
    .command('set')
    .requiredOption('--text <text>', 'context text')
    .action(async (opts: { text: string }) => {
      const path = `${deps.repoDir}/.orca/explore_context.md`;
      await Bun.$`mkdir -p ${deps.repoDir}/.orca`;
      await Bun.write(path, opts.text);
      console.log(path);
    });

  registerTaskCommands(program.command('task'), {
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    interactionStore: deps.interactionStore,
    memoryStore: deps.memoryStore,
    configStore: deps.configStore,
    registry: deps.registry,
    executor: deps.executor,
    queue: deps.queue,
  });

  registerStatusCommand(program, {
    taskStore: deps.taskStore,
    interactions: deps.interactionStore,
    memory: deps.memoryStore,
  });
  registerConfigCommands(program, deps.configStore, deps.registry);
  registerModelsCommand(program, deps.registry);
  registerCostsCommand(program, deps.interactionStore);
  registerOpsCommand(program, deps.interactionStore);
  registerOrcCommand(program, {
    repoDir: deps.repoDir,
    configStore: deps.configStore,
    registry: deps.registry,
  });
  registerMemoryCommands(program, deps.repoDir, deps.memoryStore);
  registerMergeCommands(program, {
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    configStore: deps.configStore,
    interactionStore: deps.interactionStore,
    memoryStore: deps.memoryStore,
  });
  registerPlanCommands(program, {
    taskStore: deps.taskStore,
    interactionStore: deps.interactionStore,
    registry: deps.registry,
  });
  registerReviewCommands(program, {
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    interactionStore: deps.interactionStore,
    configStore: deps.configStore,
    registry: deps.registry,
    executor: deps.executor,
  });
  registerExploreCommands(program, deps.repoDir, deps.registry);
  if (deps.queue) {
    registerQueueCommands(program, { queue: deps.queue });
  }

  await program.parseAsync(Bun.argv);
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json');
}
