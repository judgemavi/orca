import { resolveModel } from '../config/config';
import { type ToolPluginRegistry, toolDefinition } from '../plugin/registry';
import type { ToolPlugin, MCPServerDef } from '../plugin/types';
import { loadPrompt } from '../prompts/loader';
import { toErrorMessage } from '../shared/errors';
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
  'mcp__orca__worktree_cleanup',
  'mcp__orca__worktree_status',
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

export async function writeMCPConfig(
  repoDir: string,
  plugin: ToolPlugin,
): Promise<string> {
  const target = configTarget(plugin.name());
  const configPath = resolvePath(repoDir, target.file);
  await Bun.$`mkdir -p ${dirName(configPath)}`;

  const command = process.execPath || 'bun';
  const scriptPathRaw = process.argv[1]?.trim() || 'server/src/index.ts';
  const scriptPath = isAbsolutePath(scriptPathRaw)
    ? scriptPathRaw
    : `${process.cwd().replace(/\/+$/g, '')}/${scriptPathRaw}`;
  const args = [scriptPath, 'mcp'];
  const server = { command, args, cwd: repoDir };
  const existing = await Bun.file(configPath)
    .text()
    .catch(() => '');

  if (target.format === 'toml') {
    const next = upsertMCPServerTOML(
      existing,
      target.rootKey,
      target.serverKey,
      server,
    );
    await Bun.write(configPath, next);
    return configPath;
  }

  const next = upsertMCPServerJSON(
    existing,
    target.rootKey,
    target.serverKey,
    server,
  );
  await Bun.write(configPath, next);
  return configPath;
}

export async function resolveSupervisor(
  configStore: ConfigStore,
  registry: ToolPluginRegistry,
): Promise<SupervisorResolution> {
  const config = await configStore.load();
  const toolName =
    config.orchestrator.supervisorTool || config.defaultTool || 'claude';
  const plugin = toolDefinition(registry, toolName);
  if (!plugin) {
    throw new Error(`supervisor tool not available: ${toolName}`);
  }

  const model = resolveModel(
    config,
    registry,
    toolName,
    config.orchestrator.supervisorModel || '',
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

function configTarget(name: string): {
  format: 'json' | 'toml';
  file: string;
  rootKey: string;
  serverKey: string;
} {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'codex') {
    return {
      format: 'toml',
      file: '.codex/config.toml',
      rootKey: 'mcp_servers',
      serverKey: 'orca',
    };
  }
  return {
    format: 'json',
    file: '.orca/mcp.json',
    rootKey: 'mcpServers',
    serverKey: 'orca',
  };
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path);
}

function resolvePath(repoDir: string, rawPath: string): string {
  if (isAbsolutePath(rawPath)) return rawPath;
  const repo = repoDir.replace(/\/+$/g, '');
  const rel = rawPath.replace(/^\.?\//, '');
  return `${repo}/${rel}`;
}

function dirName(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '.';
  return path.slice(0, idx);
}

function upsertMCPServerJSON(
  existingRaw: string,
  rootKeyPath: string,
  serverKey: string,
  server: { command: string; args: string[]; cwd: string },
): string {
  const root = parseJSONRoot(existingRaw);
  const container = ensureObjectPath(root, rootKeyPath);
  container[serverKey] = {
    command: server.command,
    args: [...server.args],
    cwd: server.cwd,
  };
  return `${JSON.stringify(root, null, 2)}\n`;
}

function parseJSONRoot(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`invalid MCP JSON config: ${toErrorMessage(error)}`);
  }
  if (!isObject(parsed)) {
    throw new Error('invalid MCP JSON config: root must be an object');
  }
  return parsed as Record<string, unknown>;
}

function ensureObjectPath(
  root: Record<string, unknown>,
  keyPath: string,
): Record<string, unknown> {
  const parts = keyPath
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return root;

  let cursor: Record<string, unknown> = root;
  for (const part of parts) {
    const next = cursor[part];
    if (next == null) {
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
      continue;
    }
    if (!isObject(next)) {
      throw new Error(
        `invalid MCP JSON config: key path "${keyPath}" is not an object at "${part}"`,
      );
    }
    cursor = next as Record<string, unknown>;
  }
  return cursor;
}

function upsertMCPServerTOML(
  existingRaw: string,
  rootKey: string,
  serverKey: string,
  server: { command: string; args: string[]; cwd: string },
): string {
  const header = `[${rootKey}.${serverKey}]`;
  const block = [
    header,
    `command = "${escapeTOML(server.command)}"`,
    `args = [${server.args.map((arg) => `"${escapeTOML(arg)}"`).join(', ')}]`,
    `cwd = "${escapeTOML(server.cwd)}"`,
  ];

  const normalized = existingRaw.replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return `${block.join('\n')}\n`;
  }

  const lines = normalized.split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex < 0) {
    const base = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
    return `${base}\n${block.join('\n')}\n`;
  }

  let bodyEnd = headerIndex + 1;
  while (bodyEnd < lines.length && !isTOMLHeaderLine(lines[bodyEnd] ?? '')) {
    bodyEnd += 1;
  }

  const preserved = lines
    .slice(headerIndex + 1, bodyEnd)
    .filter((line) => !isManagedTOMLKey(line));

  lines.splice(headerIndex, bodyEnd - headerIndex, ...block, ...preserved);
  return `${lines.join('\n').replace(/\s*$/g, '')}\n`;
}

function isTOMLHeaderLine(line: string): boolean {
  return /^\s*\[[^\]]+\]\s*(#.*)?$/.test(line);
}

function isManagedTOMLKey(line: string): boolean {
  const stripped = line.replace(/#.*/g, '').trim();
  if (!stripped) return false;
  const match = stripped.match(/^([A-Za-z0-9_.-]+)\s*=/);
  if (!match?.[1]) return false;
  return match[1] === 'command' || match[1] === 'args' || match[1] === 'cwd';
}

function escapeTOML(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
