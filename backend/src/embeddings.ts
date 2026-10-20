import { createHash } from 'node:crypto';
import { env } from './env.js';

// Pluggable embedding providers. All return vectors of env.embeddingDim (default 1024)
// so the pgvector column dimension is stable regardless of provider.

export interface EmbeddingProvider {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
}

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((x) => x / norm);
}

/**
 * Deterministic, dependency-free lexical embedding. Hashes tokens into a
 * fixed-dimension bag-of-words vector with signed buckets, then L2-normalises.
 * Not a semantic model, but it makes the full RAG pipeline (pgvector cosine
 * search, background embed jobs) run with no second API key — ideal for dev.
 */
class LocalEmbeddingProvider implements EmbeddingProvider {
  name = 'local';
  constructor(private dim: number) {}

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = (text.toLowerCase().match(/[a-z0-9.]+/g) || []).filter((t) => t.length > 1);
    for (const tok of tokens) {
      const h = createHash('md5').update(tok).digest();
      const idx = h.readUInt32LE(0) % this.dim;
      const sign = (h[4] & 1) === 0 ? 1 : -1;
      vec[idx] += sign;
    }
    return l2normalize(vec);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

class VoyageEmbeddingProvider implements EmbeddingProvider {
  name = 'voyage';
  constructor(private apiKey: string, private model: string, private dim: number) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: texts, model: this.model, output_dimension: this.dim }),
    });
    if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai';
  constructor(private apiKey: string, private model: string, private dim: number) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: texts, model: this.model, dimensions: this.dim }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}

export function makeEmbeddingProvider(): EmbeddingProvider {
  switch (env.embeddingProvider) {
    case 'voyage':
      if (!env.voyageApiKey) throw new Error('EMBEDDING_PROVIDER=voyage but VOYAGE_API_KEY is empty');
      return new VoyageEmbeddingProvider(env.voyageApiKey, env.voyageModel, env.embeddingDim);
    case 'openai':
      if (!env.openaiApiKey) throw new Error('EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is empty');
      return new OpenAIEmbeddingProvider(env.openaiApiKey, env.openaiEmbeddingModel, env.embeddingDim);
    case 'local':
    default:
      return new LocalEmbeddingProvider(env.embeddingDim);
  }
}

export const embeddingProvider = makeEmbeddingProvider();

/** Text used to represent an entry for embedding. */
export function entryEmbeddingText(e: {
  brand: string;
  model: string;
  topic: string;
  title: string;
  text: string;
}): string {
  return `${e.brand} ${e.model} ${e.topic}\n${e.title}\n${e.text}`.trim();
}
