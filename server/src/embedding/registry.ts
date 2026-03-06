import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { log } from '../shared/logger';
import { OllamaEmbeddingPlugin } from './ollama';
import type { EmbeddingConfig, EmbeddingPlugin } from './types';
import { isEmbeddingPlugin } from './types';

export class EmbeddingRegistry {
  private readonly plugins = new Map<string, EmbeddingPlugin>();

  constructor(withBuiltins = true) {
    if (withBuiltins) {
      this.register(new OllamaEmbeddingPlugin());
    }
  }

  get(name: string): EmbeddingPlugin | undefined {
    return this.plugins.get(name.trim().toLowerCase());
  }

  registered(): string[] {
    return [...this.plugins.keys()].sort();
  }

  register(plugin: EmbeddingPlugin): void {
    const name = plugin.name().trim().toLowerCase();
    if (!name) throw new Error('embedding plugin name is required');
    if (!isEmbeddingPlugin(plugin)) {
      throw new Error(`invalid embedding plugin: ${name}`);
    }
    this.plugins.set(name, plugin);
  }

  async loadUserPlugins(dir: string): Promise<void> {
    const normalized = dir.trim();
    if (!normalized || !existsSync(normalized)) return;

    const files = await readdir(normalized);
    const candidates = files
      .filter((f) => /\.(mjs|cjs|js|ts)$/i.test(f))
      .sort();

    for (const file of candidates) {
      const absolute = `${normalized.replace(/\/+$/g, '')}/${file}`;
      const mod = await import(pathToFileURL(absolute).href);
      const maybe = mod.default ?? mod.plugin ?? mod.Plugin ?? mod;
      if (!isEmbeddingPlugin(maybe)) {
        throw new Error(
          `user embedding plugin ${file} does not implement EmbeddingPlugin interface`,
        );
      }
      this.register(maybe as EmbeddingPlugin);
    }
  }

  async resolve(config?: EmbeddingConfig): Promise<EmbeddingPlugin | null> {
    if (!config?.provider) return null;

    const name = config.provider.trim().toLowerCase();
    let plugin = this.get(name);

    if (!plugin && name === 'ollama') {
      plugin = new OllamaEmbeddingPlugin({
        baseUrl: config.baseUrl,
        model: config.model,
      });
      this.register(plugin);
    }

    if (!plugin) {
      log.warn('embedding provider not found', { provider: name });
      return null;
    }

    // Reinitialize ollama with config overrides if needed
    if (name === 'ollama' && (config.baseUrl || config.model)) {
      plugin = new OllamaEmbeddingPlugin({
        baseUrl: config.baseUrl,
        model: config.model,
      });
      this.plugins.set(name, plugin);
    }

    const ok = await plugin.available();
    if (!ok) {
      log.warn('embedding provider not available, falling back to FTS', {
        provider: name,
      });
      return null;
    }

    log.info('embedding provider ready', { provider: name });
    return plugin;
  }
}

export async function loadEmbeddingRegistry(
  repoDir: string,
): Promise<EmbeddingRegistry> {
  const registry = new EmbeddingRegistry(true);
  await registry.loadUserPlugins(`${repoDir}/.orca/plugins/embeddings`);
  return registry;
}
