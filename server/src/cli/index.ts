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
import { registerMemoryCommands } from './commands/memory';
import { registerOrcCommand } from './commands/orc';
import { registerQueueCommands } from './commands/queue';
import { registerStatusCommand } from './commands/status';
import { registerTaskCommands } from './commands/task';
import { printError, setJSONMode, setQuietMode } from './format';

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

  program.name('orca').description('Orca CLI').version('0.1.0');
  program.option('--json', 'output JSON');
  program.option('-q, --quiet', 'suppress non-essential output');

  const hasFlag = (flag: string) => Bun.argv.includes(flag);
  setJSONMode(hasFlag('--json') || !process.stdin.isTTY);
  setQuietMode(hasFlag('--quiet') || hasFlag('-q'));

  // init is handled in index.ts before bootstrap — this is a no-op so commander doesn't error on unknown command
  program
    .command('init')
    .description('Initialize orca workspace (handled at startup)')
    .action(() => {});

  const taskCmd = program
    .command('task')
    .alias('t')
    .description('Task operations');
  registerTaskCommands(taskCmd, {
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
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    interactions: deps.interactionStore,
    memory: deps.memoryStore,
  });
  registerConfigCommands(program, deps.configStore, deps.registry);
  registerCostsCommand(program, deps.interactionStore);
  registerOrcCommand(program, {
    repoDir: deps.repoDir,
    configStore: deps.configStore,
    registry: deps.registry,
  });
  registerMemoryCommands(program, deps.repoDir, deps.memoryStore);
  if (deps.queue) {
    registerQueueCommands(program, {
      queue: deps.queue,
      taskStore: deps.taskStore,
    });
  }

  // Global error handler — structured errors in JSON mode
  program.exitOverride();
  try {
    await program.parseAsync(Bun.argv);
  } catch (err: any) {
    if (
      err?.code === 'commander.helpDisplayed' ||
      err?.code === 'commander.version'
    )
      return;
    const code =
      err?.code === 'commander.missingArgument'
        ? 'MISSING_ARG'
        : err?.code === 'commander.unknownCommand'
          ? 'UNKNOWN_COMMAND'
          : err?.message?.includes('not found')
            ? 'NOT_FOUND'
            : 'ERROR';
    printError(err, code);
    process.exit(1);
  }
}
