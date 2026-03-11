import { Command } from 'commander';
import type { AppDeps } from '../types/deps';
import { registerConfigCommands } from './commands/config';
import { registerMemoryCommands } from './commands/memory';
import { registerOrcCommand } from './commands/orc';
import { registerQueueCommands } from './commands/queue';
import { registerStatusCommand } from './commands/status';
import { registerTaskCommands } from './commands/task';
import { printError, setJSONMode } from './format';

export async function runCLI(deps: AppDeps) {
  const program = new Command();

  program.name('orca').description('Orca CLI').version('0.1.0');
  program.option('--json', 'output JSON');
  program.option('-q, --quiet', 'suppress non-essential output');

  const hasFlag = (flag: string) => Bun.argv.includes(flag);
  setJSONMode(hasFlag('--json') || !process.stdin.isTTY);

  // init is handled in index.ts before bootstrap — this is a no-op so commander doesn't error on unknown command
  program
    .command('init')
    .description('Initialize orca workspace (handled at startup)')
    .action(() => {});

  const taskCmd = program
    .command('task')
    .alias('t')
    .description('Task operations');
  registerTaskCommands(taskCmd, deps);

  registerStatusCommand(program, {
    repoDir: deps.repoDir,
    db: deps.db,
    interactions: deps.interactionStore,
    memory: deps.memoryStore,
  });
  registerConfigCommands(program, deps.db, deps.registry);
  registerOrcCommand(program, {
    repoDir: deps.repoDir,
    db: deps.db,
    registry: deps.registry,
  });
  registerMemoryCommands(program, deps.repoDir, deps.memoryStore);
  registerQueueCommands(program, {
    queue: deps.queue,
    db: deps.db,
  });

  // Global error handler — structured errors in JSON mode
  program.exitOverride();
  try {
    await program.parseAsync(Bun.argv);
  } catch (err: unknown) {
    const errObj = err as Record<string, unknown> | null;
    if (
      errObj?.code === 'commander.helpDisplayed' ||
      errObj?.code === 'commander.version'
    )
      return;
    const code =
      errObj?.code === 'commander.missingArgument'
        ? 'MISSING_ARG'
        : errObj?.code === 'commander.unknownCommand'
          ? 'UNKNOWN_COMMAND'
          : String(errObj?.message ?? '').includes('not found')
            ? 'NOT_FOUND'
            : 'ERROR';
    printError(err, code);
    process.exit(1);
  }
}
