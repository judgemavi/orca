import { intro, multiselect, note, outro, spinner } from '@clack/prompts';
import { defaultConfig } from '../../config/config';
import { openDatabase } from '../../db/connection';
import { ensureIntegrationBranch } from '../../domain/worktree';
import { fallbackDriverRegistry, toolModels } from '../../driver/registry';
import { gitRun as sharedGitRun } from '../../shared/git';
import { ConfigStore } from '../../store/config';
import type { Config } from '../../types';
import { Phase } from '../../types';
import {
  confirm,
  ensureNotCancelled,
  pickFromList,
  textInput,
} from '../helpers';

interface RunInitOptions {
  yes?: boolean;
}

const ORCHESTRATOR_PHASES = [
  Phase.explore,
  Phase.plan,
  Phase.run,
  Phase.review,
  Phase.merge,
  Phase.retro,
];

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

  const registry = fallbackDriverRegistry();
  const available = registry.available();
  const missing = registry
    .registered()
    .filter((name) => !available.includes(name));

  if (available.length === 0) {
    note(missing.map((name) => `✗ ${name}`).join('\n'), 'Tool Detection');
    throw new Error('no supported tool binaries found on PATH');
  }

  // let user pick which detected tools to enable
  let enabledTools: string[];
  if (autoYes || available.length === 1) {
    enabledTools = available;
    if (available.length === 1) {
      note(`✓ ${available[0]}`, 'Tool Detection');
    }
  } else {
    enabledTools = ensureNotCancelled(
      await multiselect({
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
        initialValues: available,
        required: true,
      }),
    );
  }

  const current = alreadyInitialized
    ? await loadExistingConfig(repoDir)
    : defaultConfig();
  const defaults = buildDefaults(repoDir, current);

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

  // single tool — skip selection, go straight to model
  const defaultTool =
    enabledTools.length === 1
      ? enabledTools[0]
      : autoYes
        ? pickDefaultTool(enabledTools, defaults.defaultTool)
        : await pickFromList(
            'Default tool',
            enabledTools.map((name) => ({ label: name, value: name })),
            pickDefaultTool(enabledTools, defaults.defaultTool),
          );

  const defaultModels = toolModels(registry, defaultTool);
  const defaultModel = autoYes
    ? pickDefaultModel(defaultModels, defaults.defaultModel)
    : await pickFromList(
        `Default model (${defaultTool})`,
        defaultModels.map((model) => ({ label: model, value: model })),
        pickDefaultModel(defaultModels, defaults.defaultModel),
      );

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
        await multiselect({
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

  const supervisorTool =
    enabledTools.length === 1
      ? enabledTools[0]
      : autoYes
        ? pickDefaultTool(enabledTools, defaults.supervisorTool)
        : await pickFromList(
            'Supervisor tool',
            enabledTools.map((name) => ({ label: name, value: name })),
            pickDefaultTool(enabledTools, defaults.supervisorTool),
          );
  const supervisorModels = toolModels(registry, supervisorTool);
  const supervisorModel = autoYes
    ? pickDefaultModel(supervisorModels, defaults.supervisorModel)
    : await pickFromList(
        `Supervisor model (${supervisorTool})`,
        supervisorModels.map((model) => ({ label: model, value: model })),
        pickDefaultModel(supervisorModels, defaults.supervisorModel),
      );

  const phaseConfig: Record<string, { tool: string; model: string }> = {};
  for (const phase of ORCHESTRATOR_PHASES) {
    const phaseCurrentTool =
      current.orchestrator.phases[phase]?.tool || defaultTool;
    const phaseTool =
      enabledTools.length === 1
        ? enabledTools[0]
        : autoYes
          ? phaseCurrentTool
          : await pickFromList(
              `${phase}: tool`,
              enabledTools.map((name) => ({ label: name, value: name })),
              pickDefaultTool(enabledTools, phaseCurrentTool),
            );
    const phaseModelsRaw = toolModels(registry, phaseTool);
    const phaseModels =
      phaseModelsRaw.length > 0 ? phaseModelsRaw : defaultModels;
    const phaseCurrentModel = current.orchestrator.phases[phase]?.model || '';
    const phaseModel = autoYes
      ? phaseCurrentModel || pickDefaultModel(phaseModels, defaultModel)
      : await pickFromList(
          `${phase}: model`,
          phaseModels.map((model) => ({ label: model, value: model })),
          pickDefaultModel(phaseModels, phaseCurrentModel || defaultModel),
        );

    phaseConfig[phase] = { tool: phaseTool, model: phaseModel };
  }

  const config: Config = {
    ...current,
    project: {
      ...current.project,
      name: projectName,
      integrationBranch: integrationBranch,
      worktreeDir: '.orca/worktrees',
    },
    tools: enabledTools,
    defaultTool: defaultTool,
    defaultModel: defaultModel,
    validation: {
      commands: validationCommand ? [validationCommand] : [],
    },
    workers: {
      ...current.workers,
      maxParallel: maxParallel,
    },
    orchestrator: {
      ...current.orchestrator,
      supervisorTool: supervisorTool,
      supervisorModel: supervisorModel,
      phases: {
        ...current.orchestrator.phases,
        ...phaseConfig,
      },
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

  note(
    [
      `Project: ${projectName}`,
      `Default: ${defaultTool}/${defaultModel}`,
      `Workers: ${maxParallel}`,
      `Integration branch: ${integrationBranch}`,
      `Workspace: ${orcaDir}`,
    ].join('\n'),
    'Summary',
  );
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
    const loaded = configStore.load();
    await database.close();
    return loaded;
  } catch {
    return defaultConfig();
  }
}

function buildDefaults(repoDir: string, current: Config) {
  const projectName =
    current.project.name || baseName(repoDir) || 'orca-project';
  const validationCommand = current.validation.commands[0] ?? '';
  const budget = current.cost?.budgetUsd;
  const qualitySelected: string[] = [];
  if (current.quality.scopeCheck) qualitySelected.push('scopeCheck');
  if (current.quality.testDelta) qualitySelected.push('testDelta');
  if (current.quality.llmAlignment !== false)
    qualitySelected.push('llmAlignment');

  return {
    projectName,
    integrationBranch: current.project.integrationBranch || 'orca/integration',
    maxParallel: current.workers.maxParallel || 3,
    defaultTool: current.defaultTool || 'claude',
    defaultModel: current.defaultModel || '',
    validationCommand,
    costBudget: Number.isFinite(budget) ? String(budget) : '',
    qualitySelected,
    supervisorTool:
      current.orchestrator.supervisorTool || current.defaultTool || 'claude',
    supervisorModel:
      current.orchestrator.supervisorModel || current.defaultModel || '',
  };
}

function pickDefaultTool(available: string[], preferred: string): string {
  if (available.includes(preferred)) return preferred;
  return available[0] ?? '';
}

function pickDefaultModel(models: string[], preferred: string): string {
  if (models.includes(preferred)) return preferred;
  return models[0] ?? '';
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
