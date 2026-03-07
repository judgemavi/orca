import { resolveModel } from '../config/config';
import { type ToolPluginRegistry, toolDefinition } from '../plugin/registry';
import type { MCPServerDef, ToolPlugin } from '../plugin/types';
import { loadPrompt } from '../prompts/loader';
import type { ConfigStore } from '../store/config';

export interface SupervisorResolution {
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

function buildSystemPrompt(basePrompt: string): string {
  return basePrompt.trim();
}

export function buildMCPServerDef(repoDir: string): MCPServerDef {
  const command = process.execPath || 'bun';
  const scriptPathRaw = process.argv[1]?.trim() || 'server/src/index.ts';
  const scriptPath = isAbsolutePath(scriptPathRaw)
    ? scriptPathRaw
    : `${process.cwd().replace(/\/+$/g, '')}/${scriptPathRaw}`;
  return { command, args: [scriptPath, 'mcp'], cwd: repoDir };
}

export async function resolveSupervisor(
  configStore: ConfigStore,
  registry: ToolPluginRegistry,
): Promise<SupervisorResolution> {
  const config = await configStore.load();
  const toolName = config.orchestrator.tool || 'claude';
  const plugin = toolDefinition(registry, toolName);
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

export async function loadOrchestratorPrompt(
  repoDir: string,
  mode: 'cli' | 'mcp' = 'cli',
): Promise<string> {
  const promptName = mode === 'mcp' ? 'orchestratorMcp' : 'orchestratorCli';
  const orchestrator = await loadPrompt(repoDir, promptName);
  const outputStyle = await loadPrompt(repoDir, 'outputStyle');
  const prompt = [orchestrator.trim(), outputStyle.trim()]
    .filter(Boolean)
    .join('\n\n');
  return buildSystemPrompt(prompt);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path);
}
