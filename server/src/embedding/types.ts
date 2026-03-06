export interface EmbeddingPlugin {
  name(): string;
  dimensions(): number;
  available(): Promise<boolean>;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingConfig {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export function isEmbeddingPlugin(value: unknown): value is EmbeddingPlugin {
  if (!value || typeof value !== 'object') return false;
  const c = value as EmbeddingPlugin;
  return (
    typeof c.name === 'function' &&
    typeof c.dimensions === 'function' &&
    typeof c.available === 'function' &&
    typeof c.embed === 'function' &&
    typeof c.embedBatch === 'function'
  );
}
