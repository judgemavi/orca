import { intro, note, outro, spinner } from '@clack/prompts';
import { defaultConfig } from '../../config/config';
import { openDatabase } from '../../db/connection';
import { ensureIntegrationBranch } from '../../domain/worktree';
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

interface RunInitOptions {
  yes?: boolean;
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
  const initialEnabled = previouslyEnabled.length > 0 ? previouslyEnabled : available;

  let enabledTools: string[];
  if (autoYes || available.length === 1) {
    enabledTools = initialEnabled;
    note(
      initialEnabled.map((name) => `✓ ${name}`).join('\n'),
      'Tool Detection',
    );
  } else {
    enabledTools = ensureNotCancelled(
      await (
        await import('@clack/prompts')
      ).multiselect({
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
    ? defaults.projectName
    : await textInput('Project name', {
        defaultValue: defaults.projectName,
        required: true,
      });
  const integrationBranch = autoYes
    ? defaults.integrationBranch
    : await textInput('Integration branch', {
        defaultValue: defaults.integrationBranch,
        required: true,
      });
  const maxParallelRaw = autoYes
    ? String(defaults.maxParallel)
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
        ? pickDefault(enabledTools, defaults.orchestrator.tool)
        : await pickFromList(
            'Orchestrator tool',
            enabledTools.map((name) => ({ label: name, value: name })),
            pickDefault(enabledTools, defaults.orchestrator.tool),
          );
  const orchModels = toolModels(registry, orchestratorTool);
  const orchestratorModel = autoYes
    ? pickDefault(orchModels, defaults.orchestrator.model)
    : await pickFromList(
        'Orchestrator model',
        orchModels.map((m) => ({ label: m, value: m })),
        pickDefault(orchModels, defaults.orchestrator.model),
      );

  // Interaction defaults
  const interactions = {} as Record<InteractionType, InteractionConfig>;
  if (autoYes) {
    for (const type of INTERACTION_TYPES) {
      const def = defaults.interactions[type];
      interactions[type] = { tool: def.tool, model: def.model };
    }
  } else {
    note(
      'Configure tool and model for each interaction type.\nPress enter to accept defaults.',
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
      interactions[type] = { tool, model };
    }
  }

  const validationCommand = autoYes
    ? defaults.validationCommand
    : await textInput('Validation command (optional)', {
        defaultValue: defaults.validationCommand,
      });

  const costBudgetRaw = autoYes
    ? defaults.costBudget
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

  const qualitySelected = autoYes
    ? defaults.qualitySelected
    : ensureNotCancelled(
        await (
          await import('@clack/prompts')
        ).multiselect({
          message: 'Quality gates',
          options: [
            { value: 'scopeCheck', label: 'Scope check' },
            { value: 'testDelta', label: 'Test delta' },
            { value: 'llmAlignment', label: 'LLM alignment' },
          ],
          initialValues: defaults.qualitySelected,
          required: false,
        }),
      );

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
    },
    validation: {
      commands: validationCommand ? [validationCommand] : [],
    },
    workers: {
      ...current.workers,
      maxParallel,
    },
    quality: {
      ...current.quality,
      scopeCheck: qualitySelected.includes('scopeCheck'),
      testDelta: qualitySelected.includes('testDelta'),
      llmAlignment: qualitySelected.includes('llmAlignment'),
    },
    cost: {
      ...(current.cost ?? {}),
      budgetUsd: costBudget,
    },
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
      (type) => `  ${type}: ${interactions[type].tool}/${interactions[type].model}`,
    ),
    '',
    `Orchestrator: ${orchestratorTool}/${orchestratorModel}`,
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

function buildDefaults(
  repoDir: string,
  current: Config,
  available: string[],
) {
  const projectName =
    current.project.name || baseName(repoDir) || 'orca-project';
  const validationCommand = current.validation.commands[0] ?? '';
  const budget = current.cost?.budgetUsd;
  const qualitySelected: string[] = [];
  if (current.quality.scopeCheck) qualitySelected.push('scopeCheck');
  if (current.quality.testDelta) qualitySelected.push('testDelta');
  if (current.quality.llmAlignment !== false)
    qualitySelected.push('llmAlignment');

  const fallbackTool = available[0] ?? 'claude';

  // Build interaction defaults from current config or legacy fields
  const interactions = {} as Record<InteractionType, InteractionConfig>;
  const legacy = current as unknown as Record<string, unknown>;
  const legacyTool = String(legacy.defaultTool ?? fallbackTool);
  const legacyModel = String(legacy.defaultModel ?? '');

  for (const type of INTERACTION_TYPES) {
    if (current.interactions?.[type]) {
      interactions[type] = { ...current.interactions[type] };
    } else {
      interactions[type] = { tool: legacyTool, model: legacyModel };
    }
  }

  // Orchestrator defaults
  const orchLegacy = current.orchestrator as Record<string, unknown>;
  const orchestrator = {
    tool: current.orchestrator?.tool ??
      String(orchLegacy?.supervisorTool ?? legacyTool),
    model: current.orchestrator?.model ??
      String(orchLegacy?.supervisorModel ?? ''),
  };

  return {
    projectName,
    integrationBranch: current.project.integrationBranch || 'orca/integration',
    maxParallel: current.workers.maxParallel || 3,
    validationCommand,
    costBudget: Number.isFinite(budget) ? String(budget) : '',
    qualitySelected,
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
