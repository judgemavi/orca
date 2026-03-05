import { Command } from 'commander';
import type { Executor } from '../executor/executor';
import type { ToolPluginRegistry } from '../plugin/registry';
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
