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
  'mcp__orca__tasks_list',
  'mcp__orca__tasks_get',
  'mcp__orca__tasks_create',
  'mcp__orca__tasks_update',
  'mcp__orca__tasks_delete',
  'mcp__orca__tasks_start',
  'mcp__orca__tasks_stop',
  'mcp__orca__tasks_resume',
  'mcp__orca__tasks_add_dependency',
  'mcp__orca__breakdown',
  'mcp__orca__tasks_plan_evaluate',
  'mcp__orca__tasks_plan_generate',
  'mcp__orca__tasks_approve_plan',
  'mcp__orca__tasks_request_plan_changes',
  'mcp__orca__tasks_approve',
  'mcp__orca__tasks_request_changes',
  'mcp__orca__ai_review',
  'mcp__orca__tasks_reviews',
  'mcp__orca__merge',
  'mcp__orca__tasks_merge',
  'mcp__orca__memory_list',
  'mcp__orca__memory_search',
  'mcp__orca__memory_query',
  'mcp__orca__memory_sync',
  'mcp__orca__memory_refresh',
  'mcp__orca__memory_status',
  'mcp__orca__interactions_list',
  'mcp__orca__interaction_get',
  'mcp__orca__explore',
  'mcp__orca__explore_status',
  'mcp__orca__project_status',
  'mcp__orca__config_get',
  'mcp__orca__models_list',
  'mcp__orca__cost_status',
  'mcp__orca__quality_results',
  'mcp__orca__queue_list',
  'mcp__orca__queue_counts',
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

export async function loadOrchestratorPrompt(repoDir: string): Promise<string> {
  const orchestrator = await loadPrompt(repoDir, 'orchestrator');
  const outputStyle = await loadPrompt(repoDir, 'outputStyle');
  const prompt = [orchestrator.trim(), outputStyle.trim()]
    .filter(Boolean)
    .join('\n\n');
  return buildSystemPrompt(prompt);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path);
}
