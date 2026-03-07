import { type RunInitOptions, runInitCommand } from './cli/commands/init';

type Mode = 'mcp' | 'serve' | 'cli';

function detectMode(): Mode {
  if (Bun.argv.some((arg) => arg === 'mcp')) return 'mcp';
  if (Bun.argv.some((arg) => arg === 'serve' || arg === '--server-only'))
    return 'serve';
  return 'cli';
}

function parsePort(): number {
  const idx = Bun.argv.findIndex((arg) => arg === '-p' || arg === '--port');
  if (idx >= 0 && idx + 1 < Bun.argv.length) {
    return Number(Bun.argv[idx + 1]) || 8080;
  }
  return Number(process.env.PORT ?? '8080');
}

function isInitCommand(): boolean {
  return Bun.argv.some((arg) => arg === 'init');
}

function parseInitOptions(): RunInitOptions {
  const args = Bun.argv;
  const opts: RunInitOptions = {
    yes: args.includes('-y') || args.includes('--yes'),
  };

  const str = (flag: string): string | undefined => {
    const idx = args.findIndex((a) => a === flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  const num = (flag: string): number | undefined => {
    const v = str(flag);
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const bool = (flag: string): boolean | undefined => {
    if (args.includes(flag)) return true;
    if (args.includes(`--no-${flag.replace(/^--/, '')}`)) return false;
    return undefined;
  };
  const multi = (flag: string): string[] => {
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) {
        result.push(args[i + 1]!);
        i++;
      }
    }
    return result;
  };

  opts.name = str('--name');
  opts.integrationBranch = str('--integration-branch');
  opts.maxParallel = num('--max-parallel');
  opts.tools = multi('--tool');
  if (opts.tools.length === 0) opts.tools = undefined;
  opts.orchestratorTool = str('--orchestrator-tool');
  opts.orchestratorModel = str('--orchestrator-model');
  opts.costBudget = num('--cost-budget');
  opts.interaction = multi('--interaction');
  if (opts.interaction.length === 0) opts.interaction = undefined;

  return opts;
}

async function isInitialized(repoDir: string): Promise<boolean> {
  if (await Bun.file(`${repoDir}/.orca/.initialized`).exists()) return true;
  return Bun.file(`${repoDir}/.orca/state.db`).exists();
}

async function detectRepoDir(startDir: string): Promise<string> {
  let current = startDir;
  while (true) {
    if (
      (await Bun.file(`${current}/.git`).exists()) ||
      (await Bun.file(`${current}/.git/HEAD`).exists())
    ) {
      return current;
    }
    const parent = parentDir(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

function parentDir(path: string): string {
  const normalized = path.replace(/\/+$/g, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '/';
  return normalized.slice(0, index);
}

async function main() {
  const cwd = process.cwd();
  const repoDir = await detectRepoDir(cwd);

  if (isInitCommand()) {
    await runInitCommand(repoDir, parseInitOptions());
    return;
  }

  if (!(await isInitialized(repoDir))) {
    console.error(`not an orca workspace: ${repoDir}`);
    console.error('run "orca init" first');
    process.exit(1);
  }

  const mode = detectMode();

  switch (mode) {
    case 'mcp': {
      const { runMCPEntrypoint } = await import('./entrypoints/mcp');
      await runMCPEntrypoint(repoDir);
      break;
    }
    case 'serve': {
      const { runServeEntrypoint } = await import('./entrypoints/serve');
      await runServeEntrypoint(repoDir, parsePort());
      break;
    }
    case 'cli': {
      const { runCLIEntrypoint } = await import('./entrypoints/cli');
      await runCLIEntrypoint(repoDir);
      break;
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
