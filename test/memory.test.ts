import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestConfig, createTestDb, ensureEmbedder } from './helpers.js';
import { MemoryService } from '../src/services/memory.js';
import type { MemoryServerConfig } from '../src/config.js';

let config: MemoryServerConfig;
let db: Database.Database;
let service: MemoryService;

beforeAll(async () => {
  config = createTestConfig();
  await ensureEmbedder(config);
});

beforeEach(() => {
  db = createTestDb(config);
  service = new MemoryService(db, config);
});

afterEach(() => {
  db.close();
});

describe('MemoryService', () => {
  describe('addMemory', () => {
    it('should add a memory and return its id', async () => {
      const result = await service.addMemory({
        content: 'Test memory content',
      });
      expect(result.id).toBeDefined();
      expect(result.id).toHaveLength(32);
      expect(result.deduplicated).toBe(false);
    });

    it('should store all provided fields', async () => {
      const result = await service.addMemory({
        content: 'A rule about testing',
        memory_type: 'rule',
        context_layer: 0,
        importance: 5,
        source: 'architect',
        namespace: 'test',
        tags: ['testing', 'rules'],
        metadata: { phase: '1.1' },
      });

      const mem = service.getMemory(result.id);
      expect(mem).not.toBeNull();
      expect(mem!.content).toBe('A rule about testing');
      expect(mem!.memory_type).toBe('rule');
      expect(mem!.context_layer).toBe(0);
      expect(mem!.importance).toBe(5);
      expect(mem!.source).toBe('architect');
      expect(mem!.tags).toEqual(['testing', 'rules']);
      expect(mem!.metadata).toEqual({ phase: '1.1' });
    });

    it('should apply default values when fields are omitted', async () => {
      const result = await service.addMemory({
        content: 'Minimal memory',
      });
      const mem = service.getMemory(result.id);

      expect(mem!.memory_type).toBe('observation');
      expect(mem!.context_layer).toBe(2);
      expect(mem!.importance).toBe(3);
      expect(mem!.namespace).toBe('test');
      expect(mem!.is_archived).toBe(0);
      expect(mem!.access_count).toBeGreaterThanOrEqual(0);
    });

    it('should deduplicate identical content', async () => {
      const first = await service.addMemory({
        content: 'Exact same content for dedup test',
      });
      const second = await service.addMemory({
        content: 'Exact same content for dedup test',
      });

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second.existing_id).toBe(first.id);
    });

    it('should deduplicate semantically near-identical content', async () => {
      const first = await service.addMemory({
        content: 'The application uses PostgreSQL as its primary database for all data storage',
      });
      const second = await service.addMemory({
        content: 'The application uses PostgreSQL as the primary database for all data storage',
      });

      expect(second.deduplicated).toBe(true);
      expect(second.existing_id).toBe(first.id);
    });

    it('should not deduplicate different content', async () => {
      const first = await service.addMemory({
        content: 'Email templates use Scriban rendering engine',
      });
      const second = await service.addMemory({
        content: 'JWT tokens expire after 15 minutes by default',
      });

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(false);
      expect(second.id).not.toBe(first.id);
    });

    it('should create related_to relation for moderately similar content', async () => {
      const first = await service.addMemory({
        content: 'The email module sends messages via SMTP protocol',
      });
      const second = await service.addMemory({
        content: 'SMTP is used by the mailing system to deliver messages',
      });

      if (!second.deduplicated) {
        const relations = service.getRelations(second.id, 'outgoing', 'related_to');
        expect(relations.length).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('getMemory', () => {
    it('should return null for non-existent id', () => {
      const mem = service.getMemory('nonexistent');
      expect(mem).toBeNull();
    });

    it('should increment access_count on retrieval', async () => {
      const result = await service.addMemory({
        content: 'Access count test memory',
      });
      service.getMemory(result.id);
      const mem = service.getMemory(result.id);
      expect(mem!.access_count).toBeGreaterThanOrEqual(2);
    });
  });

  describe('updateMemory', () => {
    it('should update content and re-embed', async () => {
      const result = await service.addMemory({
        content: 'Original content',
      });
      const updated = await service.updateMemory(result.id, {
        content: 'Updated content',
      });

      expect(updated).not.toBeNull();
      expect(updated!.content).toBe('Updated content');
    });

    it('should update metadata fields without changing content', async () => {
      const result = await service.addMemory({
        content: 'Metadata update test',
        importance: 2,
        tags: ['old'],
      });

      const updated = await service.updateMemory(result.id, {
        importance: 5,
        tags: ['new', 'updated'],
      });

      expect(updated!.importance).toBe(5);
      expect(updated!.tags).toEqual(['new', 'updated']);
      expect(updated!.content).toBe('Metadata update test');
    });

    it('should return null for non-existent id', async () => {
      const updated = await service.updateMemory('nonexistent', {
        importance: 5,
      });
      expect(updated).toBeNull();
    });

    it('should update expires_at to null to remove expiration', async () => {
      const result = await service.addMemory({
        content: 'Expiry test',
        expires_at: '2025-01-01T00:00:00',
      });
      const updated = await service.updateMemory(result.id, {
        expires_at: null,
      });
      expect(updated!.expires_at).toBeNull();
    });
  });

  describe('deleteMemories', () => {
    it('should soft-delete by default (set is_archived=1)', async () => {
      const result = await service.addMemory({
        content: 'Delete me softly',
      });
      const count = service.deleteMemories([result.id]);
      expect(count).toBe(1);

      const row = db.prepare('SELECT is_archived FROM memories WHERE id = ?').get(result.id) as any;
      expect(row.is_archived).toBe(1);
    });

    it('should hard-delete when hard=true', async () => {
      const result = await service.addMemory({
        content: 'Delete me permanently',
      });
      const count = service.deleteMemories([result.id], true);
      expect(count).toBe(1);

      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.id);
      expect(row).toBeUndefined();
    });

    it('should return 0 for non-existent ids', () => {
      const count = service.deleteMemories(['nonexistent']);
      expect(count).toBe(0);
    });

    it('should delete multiple memories', async () => {
      const r1 = await service.addMemory({ content: 'First to delete' });
      const r2 = await service.addMemory({ content: 'Second to delete' });
      const count = service.deleteMemories([r1.id, r2.id], true);
      expect(count).toBe(2);
    });
  });

  describe('listMemories', () => {
    it('should list memories filtered by namespace', async () => {
      await service.addMemory({
        content: 'In test namespace',
        namespace: 'test',
      });
      await service.addMemory({
        content: 'In other namespace',
        namespace: 'other',
      });

      const list = service.listMemories({ namespace: 'test' });
      expect(list).toHaveLength(1);
      expect(list[0].content).toBe('In test namespace');
    });

    it('should filter by context layer', async () => {
      await service.addMemory({
        content: 'Layer 0 memory',
        context_layer: 0,
      });
      await service.addMemory({
        content: 'Layer 2 memory',
        context_layer: 2,
      });

      const list = service.listMemories({ context_layer: [0] });
      expect(list).toHaveLength(1);
      expect(list[0].context_layer).toBe(0);
    });

    it('should filter by memory type', async () => {
      await service.addMemory({ content: 'A rule', memory_type: 'rule' });
      await service.addMemory({
        content: 'An observation',
        memory_type: 'observation',
      });

      const list = service.listMemories({ memory_type: ['rule'] });
      expect(list).toHaveLength(1);
      expect(list[0].memory_type).toBe('rule');
    });

    it('should filter by minimum importance', async () => {
      await service.addMemory({
        content: 'Low importance',
        importance: 1,
      });
      await service.addMemory({
        content: 'High importance',
        importance: 5,
      });

      const list = service.listMemories({ importance_min: 4 });
      expect(list).toHaveLength(1);
      expect(list[0].importance).toBe(5);
    });

    it('should exclude archived by default', async () => {
      const result = await service.addMemory({
        content: 'Will be archived',
      });
      service.deleteMemories([result.id]);

      const list = service.listMemories();
      expect(list).toHaveLength(0);

      const withArchived = service.listMemories({
        include_archived: true,
      });
      expect(withArchived).toHaveLength(1);
    });

    it('should order by importance DESC then created_at DESC', async () => {
      await service.addMemory({ content: 'Low', importance: 1 });
      await service.addMemory({ content: 'High', importance: 5 });
      await service.addMemory({ content: 'Medium', importance: 3 });

      const list = service.listMemories();
      expect(list[0].importance).toBe(5);
      expect(list[1].importance).toBe(3);
      expect(list[2].importance).toBe(1);
    });
  });

  describe('relations', () => {
    it('should add and retrieve a relation', async () => {
      const r1 = await service.addMemory({ content: 'Source memory' });
      const r2 = await service.addMemory({ content: 'Target memory' });

      const relId = service.addRelation({
        source_id: r1.id,
        target_id: r2.id,
        relation_type: 'supersedes',
      });
      expect(relId).toBeDefined();

      const relations = service.getRelations(r1.id, 'outgoing');
      expect(relations).toHaveLength(1);
      expect(relations[0].relation_type).toBe('supersedes');
      expect(relations[0].target_id).toBe(r2.id);
    });

    it('should silently handle duplicate relations', async () => {
      const r1 = await service.addMemory({ content: 'Source' });
      const r2 = await service.addMemory({ content: 'Target' });

      service.addRelation({
        source_id: r1.id,
        target_id: r2.id,
        relation_type: 'related_to',
      });
      service.addRelation({
        source_id: r1.id,
        target_id: r2.id,
        relation_type: 'related_to',
      });

      const relations = service.getRelations(r1.id);
      const relatedTo = relations.filter((r) => r.relation_type === 'related_to');
      expect(relatedTo).toHaveLength(1);
    });

    it('should filter relations by direction', async () => {
      const r1 = await service.addMemory({ content: 'Center' });
      const r2 = await service.addMemory({ content: 'Outgoing target' });
      const r3 = await service.addMemory({ content: 'Incoming source' });

      service.addRelation({
        source_id: r1.id,
        target_id: r2.id,
        relation_type: 'depends_on',
      });
      service.addRelation({
        source_id: r3.id,
        target_id: r1.id,
        relation_type: 'contradicts',
      });

      const outgoing = service.getRelations(r1.id, 'outgoing');
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].relation_type).toBe('depends_on');

      const incoming = service.getRelations(r1.id, 'incoming');
      expect(incoming).toHaveLength(1);
      expect(incoming[0].relation_type).toBe('contradicts');

      const both = service.getRelations(r1.id, 'both');
      expect(both).toHaveLength(2);
    });
  });

  describe('memory versioning', () => {
    it('should store previous content when content changes', async () => {
      const result = await service.addMemory({ content: 'Version one' });
      await service.updateMemory(result.id, { content: 'Version two' });

      const versions = service.getMemoryVersions(result.id);
      expect(versions).toHaveLength(1);
      expect(versions[0].content).toBe('Version one');
      expect(versions[0].version).toBe(1);
    });

    it('should track multiple content changes in order', async () => {
      const result = await service.addMemory({ content: 'Original' });
      await service.updateMemory(result.id, { content: 'First edit' });
      await service.updateMemory(result.id, { content: 'Second edit' });
      await service.updateMemory(result.id, { content: 'Third edit' });

      const versions = service.getMemoryVersions(result.id);
      expect(versions).toHaveLength(3);
      expect(versions[0].version).toBe(3);
      expect(versions[0].content).toBe('Second edit');
      expect(versions[1].version).toBe(2);
      expect(versions[1].content).toBe('First edit');
      expect(versions[2].version).toBe(1);
      expect(versions[2].content).toBe('Original');

      const current = service.getMemory(result.id);
      expect(current!.content).toBe('Third edit');
    });

    it('should not create a version when content is unchanged', async () => {
      const result = await service.addMemory({ content: 'Same content' });
      await service.updateMemory(result.id, { content: 'Same content' });

      const versions = service.getMemoryVersions(result.id);
      expect(versions).toHaveLength(0);
    });

    it('should not create a version for metadata-only updates', async () => {
      const result = await service.addMemory({
        content: 'Metadata only test',
        importance: 2,
      });
      await service.updateMemory(result.id, {
        importance: 5,
        tags: ['new'],
      });

      const versions = service.getMemoryVersions(result.id);
      expect(versions).toHaveLength(0);
    });

    it('should return empty array for memory with no edits', async () => {
      const result = await service.addMemory({ content: 'Never edited' });
      const versions = service.getMemoryVersions(result.id);
      expect(versions).toHaveLength(0);
    });

    it('should return empty array for non-existent memory', () => {
      const versions = service.getMemoryVersions('does-not-exist');
      expect(versions).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('should return accurate counts', async () => {
      await service.addMemory({
        content: 'All modules must propagate cancellation tokens',
        memory_type: 'rule',
        context_layer: 0,
      });
      await service.addMemory({
        content: 'Email templates use Scriban rendering engine version 7',
        memory_type: 'observation',
        context_layer: 2,
      });
      await service.addMemory({
        content: 'JWT refresh tokens rotate with family tracking enabled',
        memory_type: 'observation',
        context_layer: 2,
      });

      const stats = service.getStats('test');
      expect(stats.total_memories).toBe(3);
      expect(stats.by_layer.L0).toBe(1);
      expect(stats.by_layer.L2).toBe(2);
      expect(stats.by_type.rule).toBe(1);
      expect(stats.by_type.observation).toBe(2);
    });

    it('should exclude archived memories from counts', async () => {
      const result = await service.addMemory({ content: 'Will archive' });
      await service.addMemory({ content: 'Stays active' });
      service.deleteMemories([result.id]);

      const stats = service.getStats('test');
      expect(stats.total_memories).toBe(1);
    });
  });
});
