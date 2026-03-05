import deepmerge from 'deepmerge';
import type { ToolPluginRegistry } from '../plugin/registry';
import { availableTools, toolModels } from '../plugin/registry';
import type { Config } from '../types';

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
      overrides: {},
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
  registry: ToolPluginRegistry,
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
  const supervisorModels = toolModels(
    registry,
    config.orchestrator.supervisorTool,
  );
  if (!supervisorModels.includes(config.orchestrator.supervisorModel)) {
    const fallback =
      config.orchestrator.supervisorTool === config.defaultTool
        ? config.defaultModel
        : (supervisorModels[0] ?? '');
    changes.push(
      `orchestrator.supervisorModel ${config.orchestrator.supervisorModel} -> ${fallback}`,
    );
    config.orchestrator.supervisorModel = fallback;
  }

  for (const [key, entry] of Object.entries(config.orchestrator.overrides)) {
    if (!tools.includes(entry.tool)) {
      entry.tool = config.defaultTool;
      changes.push(`orchestrator.overrides.${key}.tool -> ${entry.tool}`);
    }
    const entryModels = toolModels(registry, entry.tool);
    if (!entryModels.includes(entry.model)) {
      entry.model =
        entry.tool === config.defaultTool
          ? config.defaultModel
          : (entryModels[0] ?? '');
      changes.push(`orchestrator.overrides.${key}.model -> ${entry.model}`);
    }
  }

  return changes;
}

export function validateDefaults(
  config: Config,
  registry: ToolPluginRegistry,
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

export function resolveTool(
  config: Config,
  override: string,
  interactionType?: string,
): string {
  const explicit = override.trim();
  if (explicit) return explicit;
  const typeTool = interactionType
    ? config.orchestrator.overrides[interactionType]?.tool?.trim()
    : '';
  if (typeTool) return typeTool;
  if (config.defaultTool.trim()) return config.defaultTool;
  return config.tools[0] ?? '';
}

export function resolveModel(
  config: Config,
  registry: ToolPluginRegistry,
  toolName: string,
  override: string,
  interactionType?: string,
): string {
  if (override.trim()) return override;
  const typeModel = interactionType
    ? config.orchestrator.overrides[interactionType]?.model?.trim()
    : '';
  if (typeModel) return typeModel;
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
