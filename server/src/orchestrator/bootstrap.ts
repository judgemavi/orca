import { resolveModel } from '../config/config';
import type { OrcaDrizzleDB } from '../db/connection';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { ToolPlugin } from '../plugin/types';
import { loadPrompt } from '../prompts/loader';
import { loadConfig } from '../store/config';

interface SupervisorResolution {
  toolName: string;
  plugin: ToolPlugin;
  model: string;
}

export const ORCHESTRATOR_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
];

export async function resolveSupervisor(
  db: OrcaDrizzleDB,
  registry: ToolPluginRegistry,
): Promise<SupervisorResolution> {
  const config = await loadConfig(db);
  const toolName = config.orchestrator.tool || 'claude';
  const plugin = registry.get(toolName) ?? null;
  if (!plugin) {
    throw new Error(`supervisor tool not available: ${toolName}`);
  }

  const model = resolveModel(
    config,
    registry,
    toolName,
    config.orchestrator.model || '',
  );
  if (!model.trim()) {
    throw new Error(`supervisor model could not be resolved for ${toolName}`);
  }

  return { toolName, plugin, model };
}

export async function loadOrchestratorPrompt(repoDir: string): Promise<string> {
  const orchestrator = await loadPrompt(repoDir, 'orchestrator');
  const outputStyle = await loadPrompt(repoDir, 'outputStyle');
  const prompt = [orchestrator.trim(), outputStyle.trim()]
    .filter(Boolean)
    .join('\n\n');
  return prompt;
}
