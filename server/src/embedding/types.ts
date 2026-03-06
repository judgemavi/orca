export interface EmbeddingConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  defaultValue?: string;
  hint?: string;
}

export interface EmbeddingPlugin {
  name(): string;
  dimensions(): number;
  /** Config fields this plugin needs from the user. Empty = no config needed. */
  configFields(): EmbeddingConfigField[];
  /** Check if the backing service is reachable (server running, API key valid, etc). */
  reachable(): Promise<boolean>;
  /** Check if fully ready (reachable + model available). */
  available(): Promise<boolean>;
  /** Prepare the plugin (e.g. pull model). Resolves when ready. */
  setup?(onProgress?: (status: string) => void): Promise<void>;
  /** Embed a document for storage. */
  embed(text: string): Promise<Float32Array>;
  /** Embed multiple documents for storage. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  /** Embed a query for search. Falls back to embed() if not implemented. */
  embedQuery?(text: string): Promise<Float32Array>;
}

export interface EmbeddingConfig {
  provider: string;
  [key: string]: unknown;
}

export function isEmbeddingPlugin(value: unknown): value is EmbeddingPlugin {
  if (!value || typeof value !== 'object') return false;
  const c = value as EmbeddingPlugin;
  return (
    typeof c.name === 'function' &&
    typeof c.dimensions === 'function' &&
    typeof c.configFields === 'function' &&
    typeof c.reachable === 'function' &&
    typeof c.available === 'function' &&
    typeof c.embed === 'function' &&
    typeof c.embedBatch === 'function'
  );
}
