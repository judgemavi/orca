import deepmerge from 'deepmerge';
import type { ToolPluginRegistry } from '../plugin/registry';
import { availableTools, toolModels } from '../plugin/registry';
import type { Config, InteractionConfig, InteractionType } from '../types';
import { INTERACTION_TYPES } from '../types';

function defaultInteraction(autoRun = true): InteractionConfig {
  return { tool: 'claude', model: 'claude-sonnet-4-6', autoRun };
}

export function defaultConfig(): Config {
  const interactions = {} as Record<InteractionType, InteractionConfig>;
  for (const type of INTERACTION_TYPES) {
    interactions[type] = defaultInteraction();
  }

  return {
    project: {
      name: '',
      integrationBranch: 'orca/integration',
      worktreeDir: '.orca/worktrees',
    },
    tools: ['claude'],
    interactions,
    orchestrator: {
      tool: 'claude',
      model: '',
      mode: 'cli',
    },
    validation: { commands: [] },
    workers: { maxParallel: 3 },
    monitor: {
      stuckCheckIntervalMs: 60_000,
      maxStuckCycles: 10,
      conflictCheckIntervalMs: 30_000,
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
  if (config.monitor.stuckCheckIntervalMs <= 0) {
    throw new Error('monitor.stuckCheckIntervalMs must be > 0');
  }
  if (config.monitor.conflictCheckIntervalMs <= 0) {
    throw new Error('monitor.conflictCheckIntervalMs must be > 0');
  }
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

  const fallbackTool = tools[0] as string;

  // Migrate legacy config shape
  const legacy = config as unknown as Record<string, unknown>;
  if ('defaultTool' in legacy || 'defaultModel' in legacy) {
    const legacyTool = String(legacy.defaultTool ?? fallbackTool);
    const legacyModel = String(legacy.defaultModel ?? '');
    if (!config.interactions) {
      config.interactions = {} as Record<InteractionType, InteractionConfig>;
    }
    for (const type of INTERACTION_TYPES) {
      if (!config.interactions[type]) {
        config.interactions[type] = {
          tool: legacyTool,
          model: legacyModel,
          autoRun: true,
        };
      }
    }
    delete legacy.defaultTool;
    delete legacy.defaultModel;
    changes.push('migrated defaultTool/defaultModel to interactions');
  }
  if (legacy.orchestrator && typeof legacy.orchestrator === 'object') {
    const legacyOrch = legacy.orchestrator as Record<string, unknown>;
    if ('supervisorTool' in legacyOrch) {
      config.orchestrator.tool = String(
        legacyOrch.supervisorTool ?? fallbackTool,
      );
      config.orchestrator.model = String(legacyOrch.supervisorModel ?? '');
      delete legacyOrch.supervisorTool;
      delete legacyOrch.supervisorModel;
      delete legacyOrch.overrides;
      changes.push(
        'migrated orchestrator.supervisorTool/Model to orchestrator.tool/model',
      );
    }
  }

  // Ensure all interaction types exist
  if (!config.interactions) {
    config.interactions = {} as Record<InteractionType, InteractionConfig>;
  }
  for (const type of INTERACTION_TYPES) {
    if (!config.interactions[type]) {
      config.interactions[type] = {
        tool: fallbackTool,
        model: '',
        autoRun: true,
      };
      changes.push(`interactions.${type} added with fallback`);
    }
    if (config.interactions[type].autoRun === undefined) {
      config.interactions[type].autoRun = true;
    }
  }

  // Sanitize each interaction type
  for (const type of INTERACTION_TYPES) {
    const entry = config.interactions[type];
    if (!tools.includes(entry.tool)) {
      changes.push(
        `interactions.${type}.tool ${entry.tool} -> ${fallbackTool}`,
      );
      entry.tool = fallbackTool;
    }
    const models = toolModels(registry, entry.tool);
    if (models.length > 0 && !models.includes(entry.model)) {
      const newModel = models[0] ?? '';
      changes.push(`interactions.${type}.model ${entry.model} -> ${newModel}`);
      entry.model = newModel;
    }
  }

  // Sanitize orchestrator
  if (!config.orchestrator.mode) {
    config.orchestrator.mode = 'cli';
    changes.push('orchestrator.mode defaulted to cli');
  }
  if (!tools.includes(config.orchestrator.tool)) {
    changes.push(
      `orchestrator.tool ${config.orchestrator.tool} -> ${fallbackTool}`,
    );
    config.orchestrator.tool = fallbackTool;
  }
  const orchModels = toolModels(registry, config.orchestrator.tool);
  if (
    orchModels.length > 0 &&
    !orchModels.includes(config.orchestrator.model)
  ) {
    const newModel = orchModels[0] ?? '';
    changes.push(
      `orchestrator.model ${config.orchestrator.model} -> ${newModel}`,
    );
    config.orchestrator.model = newModel;
  }

  // Sanitize tools list
  config.tools = config.tools.filter((name) => tools.includes(name));
  if (config.tools.length === 0) {
    config.tools = [fallbackTool];
    changes.push(`tools reset to [${fallbackTool}]`);
  }

  return changes;
}

export function validateDefaults(
  config: Config,
  registry: ToolPluginRegistry,
): void {
  const tools = availableTools(registry);
  for (const type of INTERACTION_TYPES) {
    const entry = config.interactions[type];
    if (!entry) {
      throw new Error(`interactions.${type} is not configured`);
    }
    if (!tools.includes(entry.tool)) {
      throw new Error(
        `interactions.${type}.tool ${JSON.stringify(entry.tool)} not found`,
      );
    }
  }
  if (!tools.includes(config.orchestrator.tool)) {
    throw new Error(
      `orchestrator.tool ${JSON.stringify(config.orchestrator.tool)} not found`,
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
  if (interactionType) {
    const entry = config.interactions[interactionType as InteractionType];
    if (entry?.tool?.trim()) return entry.tool;
  }
  return config.interactions.code?.tool ?? config.tools[0] ?? '';
}

export function resolveModel(
  config: Config,
  registry: ToolPluginRegistry,
  toolName: string,
  override: string,
  interactionType?: string,
): string {
  if (override.trim()) return override;
  if (interactionType) {
    const entry = config.interactions[interactionType as InteractionType];
    if (entry?.model?.trim()) return entry.model;
  }
  return toolModels(registry, toolName)[0] ?? '';
}

export function isAutoRun(
  config: Config,
  interactionType: InteractionType,
  taskOverrides?: import('../types').AutoRunOverrides,
): boolean {
  if (taskOverrides && interactionType in taskOverrides) {
    return Boolean(taskOverrides[interactionType]);
  }
  return config.interactions[interactionType]?.autoRun ?? true;
}

