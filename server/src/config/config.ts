import deepmerge from 'deepmerge';
import type { DriverRegistry } from '../driver/registry';
import { availableTools, toolModels } from '../driver/registry';
import type { Config } from '../types';
import { PHASES } from '../types';

const DEFAULT_PHASES = [
  PHASES.explore,
  PHASES.plan,
  PHASES.run,
  PHASES.review,
  PHASES.merge,
  PHASES.retro,
];

export function defaultConfig(): Config {
  return {
    project: {
      name: '',
      integrationBranch: 'orca/integration',
      worktreeDir: '.orca/worktrees',
    },
    tools: ['claude'],
    defaultTool: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    validation: { commands: [] },
    workers: { maxParallel: 3 },
    orchestrator: {
      supervisorTool: 'claude',
      supervisorModel: '',
      phases: {},
    },
    monitor: {
      stuckCheckInterval: '60s',
      maxStuckCycles: 10,
      conflictCheckInterval: '30s',
    },
    quality: {
      enabled: true,
      scopeCheck: true,
      testDelta: true,
      llmAlignment: true,
    },
    postMerge: {
      enabled: true,
      retro: true,
      memorySync: true,
    },
    cost: {
      budgetUsd: 0,
    },
    logging: {
      level: 'info',
      file: '.orca/orca.log',
      maxSize: '50mb',
    },
  };
}

export function mergePatchConfig(current: Config, patch: unknown): Config {
  if (!patch || typeof patch !== 'object') return current;
  return deepmerge(current, patch as Partial<Config>, {
    arrayMerge: (_target, source) => source,
  });
}

export function validateConfig(config: Config): Config {
  if (config.workers.maxParallel < 1) {
    throw new Error(
      `workers.maxParallel must be >= 1, got ${config.workers.maxParallel}`,
    );
  }
  if (config.monitor.maxStuckCycles < 0) {
    throw new Error(
      `monitor.maxStuckCycles must be >= 0, got ${config.monitor.maxStuckCycles}`,
    );
  }
  validateDuration(
    config.monitor.stuckCheckInterval,
    'monitor.stuckCheckInterval',
  );
  validateDuration(
    config.monitor.conflictCheckInterval,
    'monitor.conflictCheckInterval',
  );
  return config;
}

export function sanitizeConfig(
  config: Config,
  registry: DriverRegistry,
): string[] {
  const changes: string[] = [];
  const tools = availableTools(registry);
  if (tools.length === 0) {
    throw new Error(
      'no available tools configured (binary check filtered all tools)',
    );
  }

  if (!tools.includes(config.defaultTool)) {
    const prior = config.defaultTool;
    config.defaultTool = tools[0] as string;
    changes.push(`defaultTool ${prior} -> ${config.defaultTool}`);
  }

  const defaultModels = toolModels(registry, config.defaultTool);
  if (!defaultModels.includes(config.defaultModel)) {
    const prior = config.defaultModel;
    config.defaultModel = defaultModels[0] ?? '';
    changes.push(`defaultModel ${prior} -> ${config.defaultModel}`);
  }

  config.tools = config.tools.filter((name) => tools.includes(name));
  if (config.tools.length === 0) {
    config.tools = [config.defaultTool];
    changes.push('tools reset to defaultTool');
  }

  if (!tools.includes(config.orchestrator.supervisorTool)) {
    changes.push(
      `orchestrator.supervisorTool ${config.orchestrator.supervisorTool} -> ${config.defaultTool}`,
    );
    config.orchestrator.supervisorTool = config.defaultTool;
  }
  const supervisorModels = toolModels(registry, config.orchestrator.supervisorTool);
  if (!supervisorModels.includes(config.orchestrator.supervisorModel)) {
    const fallback = config.orchestrator.supervisorTool === config.defaultTool
      ? config.defaultModel
      : (supervisorModels[0] ?? '');
    changes.push(
      `orchestrator.supervisorModel ${config.orchestrator.supervisorModel} -> ${fallback}`,
    );
    config.orchestrator.supervisorModel = fallback;
  }

  for (const phase of DEFAULT_PHASES) {
    const phaseCfg = config.orchestrator.phases[phase] ?? {
      tool: '',
      model: '',
    };
    if (!tools.includes(phaseCfg.tool)) {
      phaseCfg.tool = config.defaultTool;
      changes.push(`orchestrator.phases.${phase}.tool -> ${phaseCfg.tool}`);
    }
    const phaseModels = toolModels(registry, phaseCfg.tool);
    if (!phaseModels.includes(phaseCfg.model)) {
      phaseCfg.model = phaseCfg.tool === config.defaultTool
        ? config.defaultModel
        : (phaseModels[0] ?? '');
      changes.push(`orchestrator.phases.${phase}.model -> ${phaseCfg.model}`);
    }
    config.orchestrator.phases[phase] = phaseCfg;
  }

  return changes;
}

export function validateDefaults(
  config: Config,
  registry: DriverRegistry,
): void {
  const tools = availableTools(registry);
  if (!tools.includes(config.defaultTool)) {
    throw new Error(
      `defaultTool ${JSON.stringify(config.defaultTool)} not found in available tools`,
    );
  }
  const models = toolModels(registry, config.defaultTool);
  if (!models.includes(config.defaultModel)) {
    throw new Error(
      `defaultModel ${JSON.stringify(config.defaultModel)} is invalid for defaultTool ${JSON.stringify(config.defaultTool)}`,
    );
  }
}

export function resolveToolForPhase(
  config: Config,
  phase: string,
  override: string,
): string {
  const explicit = override.trim();
  if (explicit) return explicit;
  const phaseTool = config.orchestrator.phases[phase]?.tool?.trim();
  if (phaseTool) return phaseTool;
  if (config.defaultTool.trim()) return config.defaultTool;
  return config.tools[0] ?? '';
}

export function resolveModelForPhase(
  config: Config,
  registry: DriverRegistry,
  phase: string,
  toolName: string,
  override: string,
): string {
  if (override.trim()) return override;

  const phaseModel = config.orchestrator.phases[phase]?.model?.trim();
  if (phaseModel) return phaseModel;

  // Only use defaultModel if it belongs to the same tool
  if (config.defaultModel.trim() && toolName === config.defaultTool) {
    return config.defaultModel;
  }

  return toolModels(registry, toolName)[0] ?? '';
}

function validateDuration(raw: string, field: string): void {
  const normalized = raw.trim();
  if (!normalized) return;
  if (!/^(\d+(ns|us|ms|s|m|h))+$/.test(normalized)) {
    throw new Error(`${field} must be a valid duration`);
  }
}
