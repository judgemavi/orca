import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ClaudePlugin } from './claude';
import { codexPlugin } from './codex';
import type { ToolPlugin } from './types';

export class ToolPluginRegistry {
  private readonly plugins = new Map<string, ToolPlugin>();

  constructor(withBuiltins = true) {
    if (withBuiltins) {
      this.register('claude', new ClaudePlugin());
      this.register('codex', codexPlugin);
    }
  }

  get(name: string): ToolPlugin | undefined {
    return this.plugins.get(normalizePluginName(name));
  }

  registered(): string[] {
    return [...this.plugins.keys()].sort((a, b) => a.localeCompare(b));
  }

  available(): string[] {
    return [...this.plugins.entries()]
      .filter(([, plugin]) => binaryExists(plugin.binary()))
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  }

  register(name: string, plugin: ToolPlugin): void {
    const normalized = normalizePluginName(name);
    if (!normalized) throw new Error('plugin name is required');
    if (!isPlugin(plugin)) {
      throw new Error(`invalid plugin registration for ${normalized}`);
    }
    this.plugins.set(normalized, plugin);
  }

  async loadUserPlugins(dir: string): Promise<void> {
    const normalized = dir.trim();
    if (!normalized || !existsSync(normalized)) return;

    const files = await readdir(normalized);
    const candidates = files
      .filter((name) => /\.(mjs|cjs|js|ts)$/i.test(name))
      .sort((a, b) => a.localeCompare(b));

    for (const file of candidates) {
      const absolute = `${normalized.replace(/\/+$/, '')}/${file}`;
      const mod = await import(pathToFileURL(absolute).href);
      const maybe = mod.default ?? mod.plugin ?? mod.Plugin ?? mod;
      if (!isPlugin(maybe)) {
        throw new Error(
          `user plugin ${file} does not implement ToolPlugin interface`,
        );
      }
      this.register(maybe.name().toLowerCase(), maybe as ToolPlugin);
    }
  }
}

export async function loadToolPluginRegistry(
  repoDir: string,
): Promise<ToolPluginRegistry> {
  const registry = new ToolPluginRegistry(true);
  await registry.loadUserPlugins(`${repoDir}/.orca/plugins`);
  return registry;
}

export function fallbackToolPluginRegistry(): ToolPluginRegistry {
  return new ToolPluginRegistry(true);
}

function isPlugin(value: unknown): value is ToolPlugin {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as ToolPlugin;
  return (
    typeof candidate.name === 'function' &&
    typeof candidate.binary === 'function' &&
    typeof candidate.models === 'function' &&
    typeof candidate.headlessArgs === 'function' &&
    typeof candidate.resumeArgs === 'function' &&
    typeof candidate.parseEvent === 'function' &&
    typeof candidate.parseSessionID === 'function'
  );
}

function normalizePluginName(name: string): string {
  return name.trim().toLowerCase();
}

function binaryExists(binary: string): boolean {
  const normalized = binary.trim();
  if (!normalized) return false;
  if (normalized.includes('/')) return existsSync(normalized);
  return Boolean(Bun.which(normalized));
}
