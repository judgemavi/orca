import { Ollama } from 'ollama';
import { log } from '../shared/logger';
import type { EmbeddingPlugin } from './types';

const DEFAULT_MODEL = 'nomic-embed-text';

export class OllamaEmbeddingPlugin implements EmbeddingPlugin {
  private readonly client: Ollama;
  private readonly model: string;
  private dims: number | null = null;

  constructor(opts?: { baseUrl?: string; model?: string }) {
    this.client = new Ollama({ host: opts?.baseUrl });
    this.model = opts?.model || DEFAULT_MODEL;
  }

  name(): string {
    return 'ollama';
  }

  dimensions(): number {
    return this.dims ?? 768;
  }

  async available(): Promise<boolean> {
    try {
      const { models } = await this.client.list();
      return models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await this.client.embed({ model: this.model, input: text });
    const raw = res.embeddings[0];
    if (!raw) throw new Error('ollama embed returned empty result');
    const vec = new Float32Array(raw);
    if (this.dims === null) {
      this.dims = vec.length;
      log.info('detected embedding dimensions', {
        provider: 'ollama',
        model: this.model,
        dims: this.dims,
      });
    }
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await this.client.embed({ model: this.model, input: texts });
    const vectors = res.embeddings.map((arr) => new Float32Array(arr));
    if (vectors.length > 0 && this.dims === null) {
      this.dims = (vectors[0] ?? []).length;
      log.info('detected embedding dimensions', {
        provider: 'ollama',
        model: this.model,
        dims: this.dims,
      });
    }
    return vectors;
  }
}
