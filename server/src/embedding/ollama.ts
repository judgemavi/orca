import { Ollama } from 'ollama';
import { log } from '../shared/logger';
import type { EmbeddingConfigField, EmbeddingPlugin } from './types';

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_DOC_PREFIX = 'search_document: ';
const DEFAULT_QUERY_PREFIX = 'search_query: ';

export class OllamaEmbeddingPlugin implements EmbeddingPlugin {
  private readonly client: Ollama;
  private readonly model: string;
  private readonly docPrefix: string;
  private readonly queryPrefix: string;
  private dims: number | null = null;

  constructor(opts?: {
    model?: string;
    documentPrefix?: string;
    queryPrefix?: string;
  }) {
    this.client = new Ollama();
    this.model = opts?.model || DEFAULT_EMBEDDING_MODEL;
    this.docPrefix = opts?.documentPrefix ?? DEFAULT_DOC_PREFIX;
    this.queryPrefix = opts?.queryPrefix ?? DEFAULT_QUERY_PREFIX;
  }

  name(): string {
    return 'ollama';
  }

  dimensions(): number {
    return this.dims ?? 768;
  }

  configFields(): EmbeddingConfigField[] {
    return [
      {
        key: 'model',
        label: 'Embedding model',
        type: 'string',
        defaultValue: DEFAULT_EMBEDDING_MODEL,
        hint: 'Ollama model name for embeddings',
      },
      {
        key: 'documentPrefix',
        label: 'Document prefix',
        type: 'string',
        defaultValue: DEFAULT_DOC_PREFIX,
        hint: 'Prefix prepended when embedding documents for storage',
      },
      {
        key: 'queryPrefix',
        label: 'Query prefix',
        type: 'string',
        defaultValue: DEFAULT_QUERY_PREFIX,
        hint: 'Prefix prepended when embedding search queries',
      },
    ];
  }

  async reachable(): Promise<boolean> {
    try {
      await this.client.list();
      return true;
    } catch {
      return false;
    }
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

  async setup(onProgress?: (status: string) => void): Promise<void> {
    const stream = await this.client.pull({ model: this.model, stream: true });
    for await (const part of stream) {
      onProgress?.(part.status);
    }
  }

  async embed(text: string): Promise<Float32Array> {
    return this.doEmbed(`${this.docPrefix}${text}`);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const prefixed = texts.map((t) => `${this.docPrefix}${t}`);
    const res = await this.client.embed({ model: this.model, input: prefixed });
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

  async embedQuery(text: string): Promise<Float32Array> {
    return this.doEmbed(`${this.queryPrefix}${text}`);
  }

  private async doEmbed(input: string): Promise<Float32Array> {
    const res = await this.client.embed({ model: this.model, input });
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
}
