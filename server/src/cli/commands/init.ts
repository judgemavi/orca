import { intro, note, outro, spinner } from '@clack/prompts';
import { defaultConfig } from '../../config/config';
import { openDatabase } from '../../db/connection';
import { ensureIntegrationBranch } from '../../domain/worktree';
import { OllamaEmbeddingPlugin } from '../../embedding/ollama';
import type { EmbeddingPlugin } from '../../embedding/types';
import { fallbackToolPluginRegistry, toolModels } from '../../plugin/registry';
import { gitRun as sharedGitRun } from '../../shared/git';
import { ConfigStore } from '../../store/config';
import type { Config, InteractionConfig, InteractionType } from '../../types';
import { INTERACTION_TYPES } from '../../types';
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
  costBudget?: number;
  embeddingProvider?: string;
  embeddingModel?: string;
  /** Format: "type:tool:model:autoRun" e.g. "code:claude:sonnet:true" */
  interaction?: string[];
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

  const current = alreadyInitialized
    ? await loadExistingConfig(repoDir)
    : defaultConfig();
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
  const orchModels = toolModels(registry, orchestratorTool);
  const orchestratorModel = autoYes
    ? (options.orchestratorModel ??
      pickDefault(orchModels, defaults.orchestrator.model))
    : await pickFromList(
        'Orchestrator model',
        orchModels.map((m) => ({ label: m, value: m })),
        pickDefault(orchModels, defaults.orchestrator.model),
      );

  const orchestratorMode: 'cli' | 'mcp' = autoYes
    ? 'cli'
    : ((await pickFromList(
        'Orchestrator mode',
        [
          { label: 'CLI (lower token usage)', value: 'cli' },
          { label: 'MCP (structured tool calls)', value: 'mcp' },
        ],
        'cli',
      )) as 'cli' | 'mcp');

  // Interaction defaults
  const interactions = {} as Record<InteractionType, InteractionConfig>;
  const cliInteractionOverrides = parseInteractionOverrides(
    options.interaction ?? [],
  );
  if (autoYes) {
    for (const type of INTERACTION_TYPES) {
      const def = defaults.interactions[type];
      const override = cliInteractionOverrides.get(type);
      interactions[type] = {
        tool: override?.tool ?? def.tool,
        model: override?.model ?? def.model,
        autoRun: override?.autoRun ?? def.autoRun ?? true,
      };
    }
  } else {
    note(
      'Configure tool, model, and auto-run for each interaction type.\nPress enter to accept defaults.',
      'Interaction Defaults',
    );
    for (const type of INTERACTION_TYPES) {
      const def = defaults.interactions[type];
      const tool =
        enabledTools.length === 1
          ? enabledTools[0]!
          : await pickFromList(
              `${type} tool`,
              enabledTools.map((name) => ({ label: name, value: name })),
              pickDefault(enabledTools, def.tool),
            );
      const models = toolModels(registry, tool);
      const model = await pickFromList(
        `${type} model`,
        models.map((m) => ({ label: m, value: m })),
        pickDefault(models, def.model),
      );
      const autoRun = await confirm(`${type} auto-run?`, def.autoRun ?? true);
      interactions[type] = { tool, model, autoRun };
    }
  }

  const costBudgetRaw = autoYes
    ? options.costBudget != null
      ? String(options.costBudget)
      : defaults.costBudget
    : await textInput('Cost budget in USD (optional)', {
        defaultValue: defaults.costBudget,
        validate: (value) => {
          if (!value) return;
          const parsed = Number.parseFloat(value);
          if (!Number.isFinite(parsed) || parsed < 0) {
            return 'must be a number >= 0';
          }
        },
      });
  const costBudget = costBudgetRaw ? Number.parseFloat(costBudgetRaw) : 0;

  // Embeddings — discover reachable providers, prompt config fields from plugin
  const embeddingConfig: Record<string, unknown> = {};
  const embeddingPlugins: EmbeddingPlugin[] = [new OllamaEmbeddingPlugin()];
  const reachablePlugins: EmbeddingPlugin[] = [];
  for (const plugin of embeddingPlugins) {
    if (await plugin.reachable()) reachablePlugins.push(plugin);
  }

  let selectedEmbeddingPlugin: EmbeddingPlugin | null = null;
  if (reachablePlugins.length > 0) {
    const choices = [
      ...reachablePlugins.map((p) => ({ label: p.name(), value: p.name() })),
      { label: 'None (FTS only)', value: 'none' },
    ];
    const pick = autoYes
      ? (options.embeddingProvider ?? reachablePlugins[0]!.name())
      : await pickFromList(
          'Embedding provider',
          choices,
          reachablePlugins[0]!.name(),
        );

    if (pick !== 'none') {
      selectedEmbeddingPlugin =
        reachablePlugins.find((p) => p.name() === pick) ?? null;
    }
  } else if (!autoYes) {
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
        // Use CLI option override or existing/default
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

    // Setup (e.g. pull model) if plugin supports it
    if (selectedEmbeddingPlugin.setup) {
      const ready = await selectedEmbeddingPlugin.available();
      if (!ready) {
        // Reconfigure plugin with user-provided values before setup
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
    interactions,
    orchestrator: {
      tool: orchestratorTool,
      model: orchestratorModel,
      mode: orchestratorMode,
    },
    workers: {
      ...current.workers,
      maxParallel,
    },
    cost: {
      ...(current.cost ?? {}),
      budgetUsd: costBudget,
    },
    embeddings: embeddingConfig.provider
      ? (embeddingConfig as Config['embeddings'])
      : undefined,
  };

  // Remove legacy fields
  const raw = config as unknown as Record<string, unknown>;
  delete raw.defaultTool;
  delete raw.defaultModel;

  const op = spinner();
  op.start('Writing workspace config');
  await Bun.$`mkdir -p ${orcaDir}`;
  await Bun.$`mkdir -p ${logsDir}`;
  await Bun.$`mkdir -p ${worktreesDir}`;

  const database = await openDatabase({ repoDir });
  const db = database.db;
  const configStore = new ConfigStore(db);
  configStore.save(config);

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
    'Interactions:',
    ...INTERACTION_TYPES.map(
      (type) =>
        `  ${type}: ${interactions[type].tool}/${interactions[type].model} ${interactions[type].autoRun ? '(auto)' : '(manual)'}`,
    ),
    '',
    `Orchestrator: ${orchestratorTool}/${orchestratorModel}`,
    `Embeddings: ${embeddingConfig.provider ? `${embeddingConfig.provider}/${embeddingConfig.model ?? 'default'}` : 'disabled'}`,
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
  try {
    const database = await openDatabase({ repoDir });
    const db = database.db;
    const configStore = new ConfigStore(db);
    const loaded = await configStore.load();
    await database.close();
    return loaded;
  } catch {
    return defaultConfig();
  }
}

function buildDefaults(repoDir: string, current: Config, available: string[]) {
  const projectName =
    current.project.name || baseName(repoDir) || 'orca-project';

  const budget = current.cost?.budgetUsd;
  const fallbackTool = available[0] ?? 'claude';

  // Build interaction defaults from current config or legacy fields
  const interactions = {} as Record<InteractionType, InteractionConfig>;
  const legacy = current as unknown as Record<string, unknown>;
  const legacyTool = String(legacy.defaultTool ?? fallbackTool);
  const legacyModel = String(legacy.defaultModel ?? '');

  for (const type of INTERACTION_TYPES) {
    if (current.interactions?.[type]) {
      interactions[type] = { ...current.interactions[type] };
      if (interactions[type].autoRun === undefined)
        interactions[type].autoRun = true;
    } else {
      interactions[type] = {
        tool: legacyTool,
        model: legacyModel,
        autoRun: true,
      };
    }
  }

  // Orchestrator defaults
  const orchLegacy = current.orchestrator as Record<string, unknown>;
  const orchestrator = {
    tool:
      current.orchestrator?.tool ??
      String(orchLegacy?.supervisorTool ?? legacyTool),
    model:
      current.orchestrator?.model ?? String(orchLegacy?.supervisorModel ?? ''),
  };

  return {
    projectName,
    integrationBranch: current.project.integrationBranch || 'orca/integration',
    maxParallel: current.workers.maxParallel || 3,
    costBudget: Number.isFinite(budget) ? String(budget) : '',
    interactions,
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
  const next = [...lines, entry].join('\n').trim() + '\n';
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

function parseInteractionOverrides(
  raw: string[],
): Map<InteractionType, Partial<InteractionConfig>> {
  const map = new Map<InteractionType, Partial<InteractionConfig>>();
  for (const entry of raw) {
    const parts = entry.split(':');
    const type = parts[0] as InteractionType;
    if (!INTERACTION_TYPES.includes(type)) continue;
    const override: Partial<InteractionConfig> = {};
    if (parts[1]) override.tool = parts[1];
    if (parts[2]) override.model = parts[2];
    if (parts[3] != null) override.autoRun = parts[3] !== 'false';
    map.set(type, override);
  }
  return map;
}
