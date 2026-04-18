import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestConfig, createTestDb, ensureEmbedder } from './helpers.js';
import { MemoryService } from '../src/services/memory.js';
import { CleanupService } from '../src/services/cleanup.js';
import type { MemoryServerConfig } from '../src/config.js';

let config: MemoryServerConfig;
let db: Database.Database;
let memService: MemoryService;
let cleanupService: CleanupService;

beforeAll(async () => {
  config = createTestConfig();
  await ensureEmbedder(config);
});

beforeEach(() => {
  db = createTestDb(config);
  memService = new MemoryService(db, config);
  cleanupService = new CleanupService(db, config);
});

afterEach(() => {
  db.close();
});

describe('CleanupService', () => {
  describe('expired memories', () => {
    it('should archive memories past their expires_at', async () => {
      await memService.addMemory({
        content: 'This temporary scratchpad note about SMTP configuration has already expired',
        expires_at: '2020-01-01T00:00:00',
      });
      await memService.addMemory({
        content: 'JWT refresh token rotation uses family-based replay detection',
      });

      const result = cleanupService.cleanup();
      expect(result.expired).toBe(1);

      const active = memService.listMemories();
      expect(active).toHaveLength(1);
      expect(active[0].content).toContain('JWT');
    });

    it('should not archive memories with future expires_at', async () => {
      await memService.addMemory({
        content: 'Future expiry',
        expires_at: '2099-12-31T23:59:59',
      });

      const result = cleanupService.cleanup();
      expect(result.expired).toBe(0);
    });

    it('should not archive memories with null expires_at', async () => {
      await memService.addMemory({ content: 'No expiry set' });

      const result = cleanupService.cleanup();
      expect(result.expired).toBe(0);
    });
  });

  describe('old scratchpad cleanup', () => {
    it('should archive L3 memories older than 24 hours', async () => {
      db.prepare(
        `
        INSERT INTO memories (id, content, memory_type, context_layer, importance, namespace, created_at, updated_at, accessed_at)
        VALUES ('old-scratch', 'Old scratchpad note', 'scratchpad', 3, 1, 'test', datetime('now', '-48 hours'), datetime('now', '-48 hours'), datetime('now', '-48 hours'))
      `,
      ).run();

      const result = cleanupService.cleanup();
      expect(result.archived).toBe(1);
    });

    it('should not archive recent L3 memories', async () => {
      await memService.addMemory({
        content: 'Fresh scratchpad note',
        context_layer: 3,
        memory_type: 'scratchpad',
      });

      const result = cleanupService.cleanup();
      expect(result.archived).toBe(0);
    });
  });

  describe('importance promotion', () => {
    it('should promote memories with access_count >= 10', async () => {
      const result = await memService.addMemory({
        content: 'Frequently accessed research about JWT token lifecycle',
        importance: 2,
      });

      db.prepare('UPDATE memories SET access_count = 15 WHERE id = ?').run(result.id);

      const cleanup = cleanupService.cleanup();
      expect(cleanup.promoted).toBe(1);

      const mem = memService.getMemory(result.id);
      expect(mem!.importance).toBe(3);
    });

    it('should cap promotion at importance 5', async () => {
      const result = await memService.addMemory({
        content: 'Very popular memory about CORS configuration',
        importance: 4,
      });

      db.prepare('UPDATE memories SET access_count = 50 WHERE id = ?').run(result.id);

      const cleanup = cleanupService.cleanup();
      expect(cleanup.promoted).toBe(1);

      const mem = memService.getMemory(result.id);
      expect(mem!.importance).toBe(5);
    });

    it('should not promote memories already at importance 5', async () => {
      const result = await memService.addMemory({
        content: 'Maximum importance memory about security constraints',
        importance: 5,
      });

      db.prepare('UPDATE memories SET access_count = 100 WHERE id = ?').run(result.id);

      const cleanup = cleanupService.cleanup();
      expect(cleanup.promoted).toBe(0);
    });

    it('should not promote memories with access_count below threshold', async () => {
      await memService.addMemory({
        content: 'Rarely accessed memory about build tooling',
        importance: 2,
      });

      const cleanup = cleanupService.cleanup();
      expect(cleanup.promoted).toBe(0);
    });

    it('should not promote in dry run mode', async () => {
      const result = await memService.addMemory({
        content: 'Popular memory for dry run promotion test',
        importance: 2,
      });

      db.prepare('UPDATE memories SET access_count = 20 WHERE id = ?').run(result.id);

      cleanupService.cleanup({ dry_run: true });

      const mem = memService.getMemory(result.id);
      expect(mem!.importance).toBe(2);
    });
  });

  describe('importance decay', () => {
    it('should decay memories not accessed for 30+ days', async () => {
      db.prepare(
        `INSERT INTO memories (id, content, memory_type, context_layer, importance, namespace, created_at, updated_at, accessed_at)
         VALUES ('stale-mem', 'Old unused observation about EF Core indexes', 'observation', 2, 3, 'test',
                 datetime('now', '-60 days'), datetime('now', '-60 days'), datetime('now', '-45 days'))`,
      ).run();

      const cleanup = cleanupService.cleanup();
      expect(cleanup.decayed).toBe(1);

      const row = db.prepare("SELECT importance FROM memories WHERE id = 'stale-mem'").get() as any;
      expect(row.importance).toBe(2);
    });

    it('should not decay below importance 1', async () => {
      db.prepare(
        `INSERT INTO memories (id, content, memory_type, context_layer, importance, namespace, created_at, updated_at, accessed_at)
         VALUES ('min-mem', 'Already lowest importance scratchpad note', 'scratchpad', 2, 1, 'test',
                 datetime('now', '-60 days'), datetime('now', '-60 days'), datetime('now', '-45 days'))`,
      ).run();

      const cleanup = cleanupService.cleanup();
      expect(cleanup.decayed).toBe(0);
    });

    it('should not decay L0 memories', async () => {
      db.prepare(
        `INSERT INTO memories (id, content, memory_type, context_layer, importance, namespace, created_at, updated_at, accessed_at)
         VALUES ('l0-mem', 'Foundational rule that must not decay over time', 'rule', 0, 5, 'test',
                 datetime('now', '-90 days'), datetime('now', '-90 days'), datetime('now', '-90 days'))`,
      ).run();

      const cleanup = cleanupService.cleanup();
      expect(cleanup.decayed).toBe(0);
    });

    it('should not decay recently accessed memories', async () => {
      await memService.addMemory({
        content: 'Recently accessed decision about Serilog configuration',
        importance: 3,
        context_layer: 2,
      });

      const cleanup = cleanupService.cleanup();
      expect(cleanup.decayed).toBe(0);
    });

    it('should not decay in dry run mode', async () => {
      db.prepare(
        `INSERT INTO memories (id, content, memory_type, context_layer, importance, namespace, created_at, updated_at, accessed_at)
         VALUES ('dry-decay', 'Stale memory for dry run decay test', 'observation', 2, 4, 'test',
                 datetime('now', '-60 days'), datetime('now', '-60 days'), datetime('now', '-45 days'))`,
      ).run();

      cleanupService.cleanup({ dry_run: true });

      const row = db.prepare("SELECT importance FROM memories WHERE id = 'dry-decay'").get() as any;
      expect(row.importance).toBe(4);
    });
  });

  describe('dry run', () => {
    it('should report counts without making changes', async () => {
      await memService.addMemory({
        content: 'Expired for dry run test',
        expires_at: '2020-01-01T00:00:00',
      });

      const result = cleanupService.cleanup({ dry_run: true });
      expect(result.expired).toBe(1);

      const active = memService.listMemories();
      expect(active).toHaveLength(1);
    });
  });
});
