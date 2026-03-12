import { intro, note, outro, spinner } from '@clack/prompts';
import { openDatabase } from '../../db/connection';
import type { Config } from '../../db/schema';
import { ensureIntegrationBranch } from '../../domain/worktree';
import { OllamaEmbeddingPlugin } from '../../embedding/ollama';
import type { EmbeddingPlugin } from '../../embedding/types';
import { fallbackToolPluginRegistry } from '../../plugin/registry';
import { gitRun as sharedGitRun } from '../../shared/git';
import { loadConfig } from '../../store/config';
import {
  confirm,
  ensureNotCancelled,
  pickFromList,
  textInput,
} from '../helpers';

export interface RunInitOptions {
  yes?: boolean;
  name?: string;
  integrationBranch?: string;
  maxParallel?: number;
  tools?: string[];
  orchestratorTool?: string;
  orchestratorModel?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
}

export async function runInitCommand(
  repoDir: string,
  options: RunInitOptions = {},
): Promise<void> {
  const autoYes = Boolean(options.yes);
  intro('Orca init');

  const orcaDir = `${repoDir}/.orca`;
  const logsDir = `${orcaDir}/logs`;
  const worktreesDir = `${orcaDir}/worktrees`;
  const initMarker = `${orcaDir}/.initialized`;

  const alreadyInitialized =
    (await Bun.file(initMarker).exists()) ||
    (await Bun.file(`${orcaDir}/state.db`).exists()) ||
    (await Bun.file(`${orcaDir}/data/PG_VERSION`).exists());
  if (alreadyInitialized && !autoYes) {
    const proceed = await confirm(
      '.orca already exists. Reinitialize with current config as defaults?',
      false,
    );
    if (!proceed) {
      outro('Initialization cancelled.');
      return;
    }
  }

  await ensureGitPreflight(repoDir, autoYes);

  const registry = fallbackToolPluginRegistry();
  const available = registry.available();
  const missing = registry
    .registered()
    .filter((name) => !available.includes(name));

  if (available.length === 0) {
    note(missing.map((name) => `✗ ${name}`).join('\n'), 'Tool Detection');
    throw new Error('no supported tool binaries found on PATH');
  }

  const current = await loadExistingConfig(repoDir);
  const previouslyEnabled = current.tools.filter((t) => available.includes(t));
  const initialEnabled =
    previouslyEnabled.length > 0 ? previouslyEnabled : available;

  let enabledTools: string[];
  if (autoYes || available.length === 1) {
    enabledTools = options.tools?.length ? options.tools : initialEnabled;
    note(enabledTools.map((name) => `✓ ${name}`).join('\n'), 'Tool Detection');
  } else {
    enabledTools = ensureNotCancelled(
      await (await import('@clack/prompts')).multiselect({
        message: 'Enable tools',
        options: [
          ...available.map((name) => ({
            value: name,
            label: `✓ ${name}`,
            hint: 'detected',
          })),
          ...missing.map((name) => ({
            value: name,
            label: `✗ ${name}`,
            hint: 'not found',
            disabled: true,
          })),
        ],
        initialValues: initialEnabled,
        required: true,
      }),
    );
  }

  const defaults = buildDefaults(repoDir, current, available);

  const projectName = autoYes
    ? (options.name ?? defaults.projectName)
    : await textInput('Project name', {
        defaultValue: defaults.projectName,
        required: true,
      });
  const integrationBranch = autoYes
    ? (options.integrationBranch ?? defaults.integrationBranch)
    : await textInput('Integration branch', {
        defaultValue: defaults.integrationBranch,
        required: true,
      });
  const maxParallelRaw = autoYes
    ? String(options.maxParallel ?? defaults.maxParallel)
    : await textInput('Max parallel workers', {
        defaultValue: String(defaults.maxParallel),
        required: true,
        validate: (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed) || parsed < 1) {
            return 'must be an integer >= 1';
          }
        },
      });
  const maxParallel = Number.parseInt(maxParallelRaw, 10);

  // Orchestrator
  const orchestratorTool =
    enabledTools.length === 1
      ? enabledTools[0]!
      : autoYes
        ? (options.orchestratorTool ??
          pickDefault(enabledTools, defaults.orchestrator.tool))
        : await pickFromList(
            'Orchestrator tool',
            enabledTools.map((name) => ({ label: name, value: name })),
            pickDefault(enabledTools, defaults.orchestrator.tool),
          );
  const orchModels = registry.get(orchestratorTool)?.models() ?? [];
  const orchestratorModel = autoYes
    ? (options.orchestratorModel ??
      pickDefault(orchModels, defaults.orchestrator.model))
    : await pickFromList(
        'Orchestrator model',
        orchModels.map((m) => ({ label: m, value: m })),
        pickDefault(orchModels, defaults.orchestrator.model),
      );

  // Memory — ask whether to enable memory system
  const currentMemoryEnabled = current.memory?.enabled !== false;
  const memoryEnabled = autoYes
    ? currentMemoryEnabled
    : await confirm(
        'Enable memory system (retro, explore, sync)?',
        currentMemoryEnabled,
      );

  // Embeddings — only if memory enabled
  const embeddingConfig: Record<string, unknown> = {};
  const embeddingPlugins: EmbeddingPlugin[] = [new OllamaEmbeddingPlugin()];
  const reachablePlugins: EmbeddingPlugin[] = [];

  if (memoryEnabled) {
    for (const plugin of embeddingPlugins) {
      if (await plugin.reachable()) reachablePlugins.push(plugin);
    }
  }

  let selectedEmbeddingPlugin: EmbeddingPlugin | null = null;
  if (memoryEnabled && reachablePlugins.length > 0) {
    const choices = [
      ...reachablePlugins.map((p) => ({ label: p.name(), value: p.name() })),
      { label: 'None (FTS only)', value: 'none' },
    ];
    const pick = autoYes
      ? (options.embeddingProvider ?? reachablePlugins[0]?.name())
      : await pickFromList(
          'Embedding provider',
          choices,
          reachablePlugins[0]?.name(),
        );

    if (pick !== 'none') {
      selectedEmbeddingPlugin =
        reachablePlugins.find((p) => p.name() === pick) ?? null;
    }
  } else if (memoryEnabled && !autoYes) {
    note(
      'No embedding providers detected — using FTS only.\nInstall Ollama and re-run init to enable vector embeddings.',
      'Embeddings',
    );
  }

  if (selectedEmbeddingPlugin) {
    embeddingConfig.provider = selectedEmbeddingPlugin.name();
    const currentEmbConf = (current.embeddings ?? {}) as Record<
      string,
      unknown
    >;

    for (const field of selectedEmbeddingPlugin.configFields()) {
      const existing = currentEmbConf[field.key];
      const defaultVal =
        typeof existing === 'string' ? existing : (field.defaultValue ?? '');

      if (autoYes) {
        const cliKey =
          `embedding${field.key.charAt(0).toUpperCase()}${field.key.slice(1)}` as keyof RunInitOptions;
        const cliVal = options[cliKey];
        embeddingConfig[field.key] =
          typeof cliVal === 'string' ? cliVal : defaultVal || undefined;
      } else if (field.required || field.defaultValue) {
        embeddingConfig[field.key] = await textInput(
          field.label + (field.hint ? ` (${field.hint})` : ''),
          { defaultValue: defaultVal },
        );
      }
    }

    if (selectedEmbeddingPlugin.setup) {
      const ready = await selectedEmbeddingPlugin.available();
      if (!ready) {
        const configured = new OllamaEmbeddingPlugin({
          model: embeddingConfig.model as string | undefined,
        });
        const doPull =
          autoYes || (await confirm(`Model not found — set it up now?`, true));
        if (doPull) {
          const pullOp = spinner();
          pullOp.start('Setting up embedding model');
          try {
            await configured.setup((status) => pullOp.message(status));
            pullOp.stop('Embedding model ready');
          } catch (err) {
            pullOp.stop('Setup failed');
            note(
              err instanceof Error ? err.message : String(err),
              'Embedding setup failed — will use FTS fallback',
            );
          }
        }
      }
    }
  }

  const config: Config = {
    ...current,
    project: {
      ...current.project,
      name: projectName,
      integrationBranch,
      worktreeDir: '.orca/worktrees',
    },
    tools: enabledTools,
    orchestrator: {
      tool: orchestratorTool,
      model: orchestratorModel,
    },
    workers: {
      ...current.workers,
      maxParallel,
    },
    memory: {
      enabled: memoryEnabled,
      retro: memoryEnabled,
      sync: memoryEnabled,
    },
    embeddings: embeddingConfig.provider
      ? (embeddingConfig as Config['embeddings'])
      : undefined,
  };

  // Remove legacy fields
  const raw = config as unknown as Record<string, unknown>;
  delete raw.defaultTool;
  delete raw.defaultModel;
  delete raw.interactions;

  const op = spinner();
  op.start('Writing workspace config');
  await Bun.$`mkdir -p ${orcaDir}`;
  await Bun.$`mkdir -p ${logsDir}`;
  await Bun.$`mkdir -p ${worktreesDir}`;

  const database = await openDatabase({ repoDir });
  const db = database.db;
  const { saveConfig } = await import('../../store/config');
  await saveConfig(db, undefined, config);

  op.message('Updating .gitignore');
  const gitignoreChanged = await ensureGitignoreEntry(repoDir, '.orca/');
  if (gitignoreChanged) {
    await runGit(repoDir, ['add', '.gitignore']);
    await runGit(repoDir, ['commit', '-m', 'add .orca/ to .gitignore']);
  }

  op.message('Preparing git integration branch');
  await ensureIntegrationBranch(repoDir, integrationBranch);

  await database.close();
  await Bun.write(initMarker, `${new Date().toISOString()}\n`);
  op.stop('Initialization complete');

  const summaryLines = [
    `Project: ${projectName}`,
    `Workers: ${maxParallel}`,
    `Integration branch: ${integrationBranch}`,
    '',
    `Orchestrator: ${orchestratorTool}/${orchestratorModel}`,
    `Memory: ${memoryEnabled ? 'enabled' : 'disabled'}`,
    `Embeddings: ${embeddingConfig.provider ? `${embeddingConfig.provider}/${embeddingConfig.model ?? 'default'}` : memoryEnabled ? 'FTS only' : 'disabled'}`,
    `Workspace: ${orcaDir}`,
  ];
  note(summaryLines.join('\n'), 'Summary');
  outro('Orca is ready.');
}

async function ensureGitPreflight(
  repoDir: string,
  autoYes: boolean,
): Promise<void> {
  const inRepo = await isGitRepo(repoDir);
  if (!inRepo) {
    if (!autoYes) {
      const ok = await confirm(
        'No git repository detected. Run git init?',
        true,
      );
      if (!ok) {
        throw new Error('git repository required');
      }
    }
    await runGit(repoDir, ['init']);
  }
}

async function loadExistingConfig(repoDir: string): Promise<Config> {
  const database = openDatabase({ repoDir });
  const db = database.db;
  const loaded = await loadConfig(db).catch(
    () =>
      ({
        project: {},
        tools: [],
        orchestrator: {},
        workers: {},
      }) as unknown as Config,
  );
  database.close();
  return loaded;
}

function buildDefaults(repoDir: string, current: Config, available: string[]) {
  const projectName =
    current.project.name || baseName(repoDir) || 'orca-project';

  const fallbackTool = available[0] ?? 'claude';

  const orchLegacy = current.orchestrator as Record<string, unknown>;
  const orchestrator = {
    tool:
      current.orchestrator?.tool ??
      String(orchLegacy?.supervisorTool ?? fallbackTool),
    model:
      current.orchestrator?.model ?? String(orchLegacy?.supervisorModel ?? ''),
  };

  return {
    projectName,
    integrationBranch: current.project.integrationBranch || 'orca/integration',
    maxParallel: current.workers.maxParallel || 3,
    orchestrator,
  };
}

function pickDefault(options: string[], preferred: string): string {
  if (options.includes(preferred)) return preferred;
  return options[0] ?? '';
}

async function ensureGitignoreEntry(
  repoDir: string,
  entry: string,
): Promise<boolean> {
  const path = `${repoDir}/.gitignore`;
  const current = (
    await Bun.file(path)
      .text()
      .catch(() => '')
  ).trim();
  const lines = current ? current.split('\n') : [];
  if (lines.includes(entry)) return false;
  const next = `${[...lines, entry].join('\n').trim()}\n`;
  await Bun.write(path, next);
  return true;
}

async function isGitRepo(repoDir: string): Promise<boolean> {
  const result = await runGit(
    repoDir,
    ['rev-parse', '--is-inside-work-tree'],
    true,
  );
  return result.exitCode === 0;
}

async function runGit(
  repoDir: string,
  args: string[],
  allowFailure = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await sharedGitRun(repoDir, args);
  const stdout = result.stdout;
  const stderr = result.stderr;
  const exitCode = result.exitCode;
  if (!allowFailure && exitCode !== 0) {
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }
  return { exitCode, stdout, stderr };
}

function baseName(path: string): string {
  const normalized = path.replace(/\/+$/g, '');
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return normalized;
  return normalized.slice(idx + 1);
}
