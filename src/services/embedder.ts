import type { MemoryServerConfig } from '../config.js';

let pipeline: Function | null = null;
let extractor: any = null;

export async function initEmbedder(config: MemoryServerConfig): Promise<void> {
  if (extractor) return;

  const { pipeline: pipelineFn, env } = await import('@huggingface/transformers');
  env.cacheDir = config.modelCacheDir;
  env.allowLocalModels = true;

  pipeline = pipelineFn;
  extractor = await pipelineFn('feature-extraction', config.embeddingModel, {
    dtype: 'fp32',
  });
}

export async function embed(text: string): Promise<Float32Array> {
  if (!extractor) {
    throw new Error('Embedder not initialized. Call initEmbedder() first.');
  }

  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
