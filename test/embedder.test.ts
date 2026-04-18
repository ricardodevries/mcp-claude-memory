import { describe, it, expect, beforeAll } from 'vitest';
import { createTestConfig, ensureEmbedder } from './helpers.js';
import { embed, embedBatch, cosineSimilarity } from '../src/services/embedder.js';

beforeAll(async () => {
  const config = createTestConfig();
  await ensureEmbedder(config);
});

describe('Embedder', () => {
  describe('embed', () => {
    it('should return a Float32Array with 384 dimensions', async () => {
      const vec = await embed('Hello world');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
    });

    it('should produce normalized vectors (unit length)', async () => {
      const vec = await embed('Test sentence for normalization');
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      expect(Math.sqrt(norm)).toBeCloseTo(1.0, 2);
    });

    it('should produce different embeddings for different text', async () => {
      const v1 = await embed('The cat sat on the mat');
      const v2 = await embed('Quantum computing enables parallel computation');
      let identical = true;
      for (let i = 0; i < v1.length; i++) {
        if (Math.abs(v1[i] - v2[i]) > 0.001) {
          identical = false;
          break;
        }
      }
      expect(identical).toBe(false);
    });

    it('should produce consistent embeddings for the same text', async () => {
      const v1 = await embed('Deterministic embedding test');
      const v2 = await embed('Deterministic embedding test');
      const sim = cosineSimilarity(v1, v2);
      expect(sim).toBeCloseTo(1.0, 4);
    });
  });

  describe('embedBatch', () => {
    it('should embed multiple texts', async () => {
      const vectors = await embedBatch(['First text', 'Second text', 'Third text']);
      expect(vectors).toHaveLength(3);
      for (const vec of vectors) {
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);
      }
    });
  });

  describe('cosineSimilarity', () => {
    it('should return high similarity for semantically similar text', async () => {
      const v1 = await embed('The cat sat on the mat');
      const v2 = await embed('A feline was resting on a rug');
      const sim = cosineSimilarity(v1, v2);
      expect(sim).toBeGreaterThan(0.3);
    });

    it('should return low similarity for unrelated text', async () => {
      const v1 = await embed('The cat sat on the mat');
      const v2 = await embed('Quarterly financial reports show increased revenue');
      const sim = cosineSimilarity(v1, v2);
      expect(sim).toBeLessThan(0.3);
    });

    it('should return 1.0 for identical vectors', async () => {
      const v = await embed('Identical test');
      const sim = cosineSimilarity(v, v);
      expect(sim).toBeCloseTo(1.0, 4);
    });

    it('should be symmetric', async () => {
      const v1 = await embed('First sentence');
      const v2 = await embed('Second sentence');
      const sim12 = cosineSimilarity(v1, v2);
      const sim21 = cosineSimilarity(v2, v1);
      expect(sim12).toBeCloseTo(sim21, 6);
    });
  });
});
