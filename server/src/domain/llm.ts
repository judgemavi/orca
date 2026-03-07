import { defaultConfig, resolveModel, resolveTool } from '../config/config';
import {
  fallbackToolPluginRegistry,
  type ToolPluginRegistry,
  toolDefinition,
} from '../plugin/registry';
import type { ToolPlugin, ToolPluginEvent } from '../plugin/types';
import { camelizeKeys } from '../shared/camelize';
import type { Config } from '../types';

interface ResolveExecutionInput {
  config?: Config;
  registry?: ToolPluginRegistry;
  toolOverride?: string;
  modelOverride?: string;
  interactionType?: string;
}

interface ResolvedExecution {
  toolName: string;
  plugin: ToolPlugin;
  model: string;
  config: Config;
  registry: ToolPluginRegistry;
}

export function resolveExecution(
  input: ResolveExecutionInput,
): ResolvedExecution | null {
  const config = input.config ?? defaultConfig();
  const registry = input.registry ?? fallbackToolPluginRegistry();
  const toolOverride = input.toolOverride ?? '';
  const modelOverride = input.modelOverride ?? '';

  const interactionType = input.interactionType?.trim() || '';

  let toolName = resolveTool(
    config,
    toolOverride,
    interactionType || undefined,
  );
  let plugin = toolDefinition(registry, toolName);

  if (!plugin) {
    const fallbackTool =
      registry.available()[0] ?? registry.registered()[0] ?? '';
    if (!fallbackTool) return null;
    toolName = fallbackTool;
    plugin = toolDefinition(registry, toolName);
    if (!plugin) return null;
  }

  let model = resolveModel(
    config,
    registry,
    toolName,
    modelOverride,
    interactionType || undefined,
  ).trim();
  if (!model) {
    model = plugin.models()[0]?.trim() ?? '';
  }
  if (!model) return null;

  return { toolName, plugin, model, config, registry };
}

export function collectAssistantText(events: ToolPluginEvent[]): string {
  return events
    .filter((event) => event.type === 'text')
    .map((event) => event.text ?? '')
    .join('')
    .trim();
}

export function formatTemplate(template: string, values: string[]): string {
  let out = template;
  for (const value of values) {
    out = out.replace('%s', value);
  }
  return out;
}

export function extractJSONObject<T>(text: string): T | null {
  for (const candidate of jsonCandidates(text, '{', '}')) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return camelizeKeys(parsed) as T;
      }
    } catch {
      // Ignore parse failures and continue scanning.
    }
  }
  return null;
}

export function extractJSONArray<T>(text: string): T[] | null {
  for (const candidate of jsonCandidates(text, '[', ']')) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        return camelizeKeys(parsed) as T[];
      }
    } catch {
      // Ignore parse failures and continue scanning.
    }
  }
  return null;
}

function jsonCandidates(text: string, open: string, close: string): string[] {
  const raw = text.trim();
  if (!raw) return [];

  const candidates: string[] = [raw];
  for (const fenced of extractFencedCodeBlocks(raw)) {
    candidates.push(fenced);
  }
  for (const balanced of extractBalancedJSONBlocks(raw, open, close)) {
    candidates.push(balanced);
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function extractFencedCodeBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(re)) {
    const body = String(match[1] ?? '').trim();
    if (body) out.push(body);
  }
  return out;
}

function extractBalancedJSONBlocks(
  text: string,
  open: string,
  close: string,
): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === close) {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return out;
}
