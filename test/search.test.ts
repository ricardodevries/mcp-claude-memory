import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestConfig, createTestDb, ensureEmbedder } from './helpers.js';
import { MemoryService } from '../src/services/memory.js';
import { SearchService } from '../src/services/search.js';
import type { MemoryServerConfig } from '../src/config.js';

let config: MemoryServerConfig;
let db: Database.Database;
let memService: MemoryService;
let searchService: SearchService;

beforeAll(async () => {
  config = createTestConfig();
  await ensureEmbedder(config);
});

beforeEach(async () => {
  db = createTestDb(config);
  memService = new MemoryService(db, config);
  searchService = new SearchService(db, config);

  await memService.addMemory({
    content: 'EmailModule uses Scriban for template rendering',
    memory_type: 'observation',
    context_layer: 2,
    importance: 3,
  });
  await memService.addMemory({
    content: 'JWT tokens expire after 15 minutes by default',
    memory_type: 'decision',
    context_layer: 1,
    importance: 4,
  });
  await memService.addMemory({
    content: 'All IModule implementations must propagate OperationCanceledException',
    memory_type: 'rule',
    context_layer: 0,
    importance: 5,
  });
  await memService.addMemory({
    content: 'sqlite-vec supports KNN search with sub-75ms latency at 100K vectors',
    memory_type: 'research',
    context_layer: 2,
    importance: 3,
  });
  await memService.addMemory({
    content: 'The SMTP sender detects CRLF injection in email headers',
    memory_type: 'observation',
    context_layer: 2,
    importance: 4,
  });
});

afterEach(() => {
  db.close();
});

describe('SearchService', () => {
  describe('hybrid search', () => {
    it('should find semantically relevant memories', async () => {
      const results = await searchService.search({
        query: 'template rendering engine',
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('Scriban');
    });

    it('should rank more relevant results higher', async () => {
      const results = await searchService.search({
        query: 'email header injection security',
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('CRLF');
    });

    it('should return results with relevance scores', async () => {
      const results = await searchService.search({
        query: 'token expiration',
      });
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.relevance).toBeTypeOf('number');
        expect(result.relevance).toBeGreaterThan(0);
      }
    });

    it('should respect limit parameter', async () => {
      const results = await searchService.search({
        query: 'module',
        limit: 2,
      });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('semantic search', () => {
    it('should use vector-only search', async () => {
      const results = await searchService.search({
        query: 'cancellation token propagation exception handling',
        search_mode: 'semantic',
      });
      expect(results.length).toBeGreaterThan(0);
      const hasRelevant = results.some(
        (r) => r.content.includes('OperationCanceledException') || r.content.includes('IModule'),
      );
      expect(hasRelevant).toBe(true);
    });
  });

  describe('lexical search', () => {
    it('should use FTS5-only search', async () => {
      const results = await searchService.search({
        query: 'SMTP CRLF',
        search_mode: 'lexical',
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('SMTP');
    });

    it('should return empty for no matches', async () => {
      const results = await searchService.search({
        query: 'xyznonexistent123',
        search_mode: 'lexical',
      });
      expect(results).toHaveLength(0);
    });
  });

  describe('filters', () => {
    it('should filter by context layer', async () => {
      const results = await searchService.search({
        query: 'module implementation',
        context_layer: [0],
      });
      for (const result of results) {
        expect(result.context_layer).toBe(0);
      }
    });

    it('should filter by memory type', async () => {
      const results = await searchService.search({
        query: 'search vector',
        memory_type: ['research'],
      });
      for (const result of results) {
        expect(result.memory_type).toBe('research');
      }
    });

    it('should filter by minimum importance', async () => {
      const results = await searchService.search({
        query: 'email',
        importance_min: 4,
      });
      for (const result of results) {
        expect(result.importance).toBeGreaterThanOrEqual(4);
      }
    });

    it('should not return archived memories', async () => {
      const added = await memService.addMemory({
        content: 'This will be archived before search',
      });
      memService.deleteMemories([added.id]);

      const results = await searchService.search({
        query: 'archived before search',
      });
      const archivedResult = results.find((r) => r.id === added.id);
      expect(archivedResult).toBeUndefined();
    });
  });

  describe('namespace isolation', () => {
    it('should only return memories from the specified namespace', async () => {
      await memService.addMemory({
        content: 'Memory in other namespace about templates',
        namespace: 'other',
      });

      const results = await searchService.search({
        query: 'templates',
        namespace: 'other',
      });
      for (const result of results) {
        expect(result.namespace).toBe('other');
      }
    });
  });
});
