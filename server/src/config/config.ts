import { type Config, CURRENT_SCHEMA_VERSION } from '../db/schema';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { AutoRunOverrides } from '../types/api';

export function sanitizeConfig(
  config: Config,
  registry: ToolPluginRegistry,
): string[] {
  const changes: string[] = [];
  const tools = registry.available();
  if (tools.length === 0) {
    throw new Error(
      'no available tools configured (binary check filtered all tools)',
    );
  }

  const fallbackTool = tools[0] as string;
  const version = config.schemaVersion ?? 1;

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `config schemaVersion ${version} is newer than supported ${CURRENT_SCHEMA_VERSION} — upgrade orca`,
    );
  }

  // v1 → v2: migrate postMerge.retro/memorySync → memory config
  if (version < 2) {
    const legacy = config as unknown as Record<string, unknown>;
    const legacyPostMerge = legacy.postMerge as
      | Record<string, unknown>
      | undefined;
    if (legacyPostMerge) {
      if (!config.memory) {
        config.memory = { enabled: true, retro: true, sync: true };
      }
      if ('retro' in legacyPostMerge) {
        config.memory.retro = legacyPostMerge.retro !== false;
        delete legacyPostMerge.retro;
        changes.push('migrated postMerge.retro → memory.retro');
      }
      if ('memorySync' in legacyPostMerge) {
        config.memory.sync = legacyPostMerge.memorySync !== false;
        delete legacyPostMerge.memorySync;
        changes.push('migrated postMerge.memorySync → memory.sync');
      }
    }
  }

  // v2 → v3: strip legacy interactions/defaultTool/defaultModel
  const legacy = config as unknown as Record<string, unknown>;
  delete legacy.defaultTool;
  delete legacy.defaultModel;
  delete legacy.interactions;

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
    if ('mode' in legacyOrch) {
      delete legacyOrch.mode;
      changes.push('removed orchestrator.mode; CLI is now the only mode');
    }
  }

  config.schemaVersion = CURRENT_SCHEMA_VERSION;

  if (!tools.includes(config.orchestrator.tool)) {
    changes.push(
      `orchestrator.tool ${config.orchestrator.tool} -> ${fallbackTool}`,
    );
    config.orchestrator.tool = fallbackTool;
  }
  const orchModels = registry.get(config.orchestrator.tool)?.models() ?? [];
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
  const tools = registry.available();
  if (!tools.includes(config.orchestrator.tool)) {
    throw new Error(
      `orchestrator.tool ${JSON.stringify(config.orchestrator.tool)} not found`,
    );
  }
}

export function resolveTool(config: Config, override: string): string {
  const explicit = override.trim();
  if (explicit) return explicit;
  return config.tools[0] ?? '';
}

export function resolveModel(
  _config: Config,
  registry: ToolPluginRegistry,
  toolName: string,
  override: string,
): string {
  if (override.trim()) return override;
  return registry.get(toolName)?.models()[0] ?? '';
}

/**
 * Resolution order:
 * 1. Global config.autoRun — if false, nothing auto-runs
 * 2. Per-task overrides — task.autoRunOverrides[stepName]
 * 3. Workflow step def — step.autoRun
 * 4. Default: true
 */
interface AutoRunCheck {
  config: Config;
  stepName: string;
  stepAutoRun?: boolean;
  taskOverrides?: AutoRunOverrides;
}

export function isAutoRun(opts: AutoRunCheck): boolean {
  if (opts.config.autoRun === false) return false;
  if (opts.taskOverrides) {
    // Check full dotted path first (e.g., "implement.code"), then leaf name (e.g., "code")
    if (opts.stepName in opts.taskOverrides) {
      return Boolean(opts.taskOverrides[opts.stepName]);
    }
    const leaf = opts.stepName.includes('.')
      ? opts.stepName.slice(opts.stepName.lastIndexOf('.') + 1)
      : '';
    if (leaf && leaf in opts.taskOverrides) {
      return Boolean(opts.taskOverrides[leaf]);
    }
  }
  return opts.stepAutoRun ?? true;
}
