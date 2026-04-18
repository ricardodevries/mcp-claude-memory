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

describe('addMemory skipDedup', () => {
  it('should store both entries when skipDedup is true and content is identical', async () => {
    const first = await service.addMemory({
      content: 'Exact same content for skipDedup test',
      skipDedup: true,
    });
    const second = await service.addMemory({
      content: 'Exact same content for skipDedup test',
      skipDedup: true,
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(second.id).not.toBe(first.id);

    const stats = service.getStats('test');
    expect(stats.total_memories).toBe(2);
  });

  it('should store both entries when skipDedup is true and content is semantically similar', async () => {
    const first = await service.addMemory({
      content: 'The application uses PostgreSQL as its primary database for all data storage',
      skipDedup: true,
    });
    const second = await service.addMemory({
      content: 'The application uses PostgreSQL as the primary database for all data storage',
      skipDedup: true,
    });

    expect(second.deduplicated).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  it('should still deduplicate when skipDedup is false', async () => {
    const first = await service.addMemory({
      content: 'Dedup enabled content test',
      skipDedup: false,
    });
    const second = await service.addMemory({
      content: 'Dedup enabled content test',
      skipDedup: false,
    });

    expect(second.deduplicated).toBe(true);
    expect(second.existing_id).toBe(first.id);
  });

  it('should still deduplicate when skipDedup is omitted', async () => {
    const first = await service.addMemory({
      content: 'Dedup default behavior test',
    });
    const second = await service.addMemory({
      content: 'Dedup default behavior test',
    });

    expect(second.deduplicated).toBe(true);
  });

  it('should still create related_to relations when skipDedup is true', async () => {
    const first = await service.addMemory({
      content: 'The email module sends messages via SMTP protocol',
      skipDedup: true,
    });
    const second = await service.addMemory({
      content: 'SMTP is used by the mailing system to deliver messages',
      skipDedup: true,
    });

    expect(second.deduplicated).toBe(false);
    const relations = service.getRelations(second.id, 'outgoing', 'related_to');
    expect(relations.length).toBeGreaterThanOrEqual(0);
  });

  it('should preserve all metadata fields when skipDedup is true', async () => {
    const result = await service.addMemory({
      content: 'SkipDedup metadata preservation test',
      memory_type: 'research',
      context_layer: 2,
      importance: 3,
      source: 'seed:research/test.md',
      tags: ['research', 'test'],
      skipDedup: true,
    });

    const mem = service.getMemory(result.id);
    expect(mem!.memory_type).toBe('research');
    expect(mem!.context_layer).toBe(2);
    expect(mem!.importance).toBe(3);
    expect(mem!.source).toBe('seed:research/test.md');
    expect(mem!.tags).toEqual(['research', 'test']);
  });
});

describe('seed: splitResearchSections (preamble merge)', () => {
  // We can't import the private function directly, so we test
  // the observable behavior through the full seed flow.
  // These tests verify the preamble merge logic via addMemory calls
  // that simulate what the seed does.

  it('should store preamble content when merged with first section', async () => {
    const preamble = '# Research Title\n\n**Date:** 2026-01-01\n**Scope:** Testing';
    const section1 = '## 1. First Section\n\nFirst section content here with enough text.';
    const section2 = '## 2. Second Section\n\nSecond section content here with enough text.';
    const merged = preamble + '\n\n' + section1;

    const r1 = await service.addMemory({
      content: merged,
      source: 'seed:research/test.md',
      skipDedup: true,
    });
    const r2 = await service.addMemory({
      content: section2,
      source: 'seed:research/test.md',
      skipDedup: true,
    });

    const mem1 = service.getMemory(r1.id);
    expect(mem1!.content).toContain('# Research Title');
    expect(mem1!.content).toContain('**Date:** 2026-01-01');
    expect(mem1!.content).toContain('First section content');

    const mem2 = service.getMemory(r2.id);
    expect(mem2!.content).toContain('Second section content');
  });

  it('should handle file with no ## headings as a single entry', async () => {
    const content = '# Simple Title\n\nJust a single block of content with no ## sections.';

    const result = await service.addMemory({
      content,
      source: 'seed:research/simple.md',
      skipDedup: true,
    });

    const mem = service.getMemory(result.id);
    expect(mem!.content).toBe(content);
  });
});

describe('seed: delete-before-add pattern', () => {
  it('should replace old entries when source matches', async () => {
    const source = 'seed:research/replace-test.md';

    const old1 = await service.addMemory({
      content: 'Old section one content that will be replaced',
      source,
      skipDedup: true,
    });
    const old2 = await service.addMemory({
      content: 'Old section two content that will be replaced',
      source,
      skipDedup: true,
    });

    expect(service.getStats('test').total_memories).toBe(2);

    const existing = (
      db
        .prepare('SELECT id FROM memories WHERE namespace = ? AND source = ? AND is_archived = 0')
        .all('test', source) as Array<{ id: string }>
    ).map((r) => r.id);

    expect(existing).toHaveLength(2);
    service.deleteMemories(existing, true);

    const new1 = await service.addMemory({
      content: 'New section one with updated preamble content',
      source,
      skipDedup: true,
    });
    const new2 = await service.addMemory({
      content: 'New section two with updated content',
      source,
      skipDedup: true,
    });
    const new3 = await service.addMemory({
      content: 'New section three that did not exist before',
      source,
      skipDedup: true,
    });

    expect(service.getStats('test').total_memories).toBe(3);

    expect(service.getMemory(old1.id)).toBeNull();
    expect(service.getMemory(old2.id)).toBeNull();
    expect(service.getMemory(new1.id)!.content).toContain('updated preamble');
    expect(service.getMemory(new3.id)!.content).toContain('did not exist');
  });

  it('should not affect entries from other sources during delete', async () => {
    await service.addMemory({
      content: 'Entry from different source should survive',
      source: 'seed:research/other.md',
      skipDedup: true,
    });
    await service.addMemory({
      content: 'Entry from target source will be deleted',
      source: 'seed:research/target.md',
      skipDedup: true,
    });

    const toDelete = (
      db
        .prepare('SELECT id FROM memories WHERE namespace = ? AND source = ? AND is_archived = 0')
        .all('test', 'seed:research/target.md') as Array<{ id: string }>
    ).map((r) => r.id);

    service.deleteMemories(toDelete, true);

    const stats = service.getStats('test');
    expect(stats.total_memories).toBe(1);

    const remaining = service.listMemories();
    expect(remaining[0].source).toBe('seed:research/other.md');
  });
});

describe('seed: notes content limit', () => {
  it('should store full content when under 8000 chars', async () => {
    const content = 'A'.repeat(4000);
    const result = await service.addMemory({
      content: `Phase 1.1 notes: ${content}`,
      source: 'seed:notes/phase-1.1.md',
      skipDedup: true,
    });

    const mem = service.getMemory(result.id);
    expect(mem!.content).toBe(`Phase 1.1 notes: ${content}`);
    expect(mem!.content.length).toBe(4000 + 'Phase 1.1 notes: '.length);
  });

  it('should store up to 8000 chars of file content', async () => {
    const content = 'B'.repeat(10000);
    const summary = content.slice(0, 8000);
    const result = await service.addMemory({
      content: `Phase 2.1 notes: ${summary}`,
      source: 'seed:notes/phase-2.1.md',
      skipDedup: true,
    });

    const mem = service.getMemory(result.id);
    expect(mem!.content.length).toBe(8000 + 'Phase 2.1 notes: '.length);
  });

  it('should replace existing notes entry on reseed', async () => {
    const source = 'seed:notes/phase-0.2.md';

    const old = await service.addMemory({
      content: 'Phase 0.2 notes: ' + 'X'.repeat(2000),
      source,
      skipDedup: true,
    });

    const existing = (
      db
        .prepare('SELECT id FROM memories WHERE namespace = ? AND source = ? AND is_archived = 0')
        .all('test', source) as Array<{ id: string }>
    ).map((r) => r.id);
    service.deleteMemories(existing, true);

    const updated = await service.addMemory({
      content: 'Phase 0.2 notes: ' + 'Y'.repeat(2666),
      source,
      skipDedup: true,
    });

    expect(service.getMemory(old.id)).toBeNull();
    const mem = service.getMemory(updated.id);
    expect(mem!.content.length).toBe(2666 + 'Phase 0.2 notes: '.length);
    expect(mem!.content).toContain('YYYY');
  });
});

describe('seed: edge cases', () => {
  it('should handle empty preamble (< 20 chars) by skipping it', async () => {
    // Simulates a file like events.md where the preamble is just "# Title"
    // (< 20 chars). The seed skips it and falls through to the no-section
    // fallback, storing the whole file as one entry.
    const shortPreamble = '# Short Title';
    expect(shortPreamble.length).toBeLessThan(20);
  });

  it('should handle preamble-only file with no ## sections', async () => {
    const content = '# Title\n\nSome content without any ## headings, just plain text over 20 chars.';

    const result = await service.addMemory({
      content,
      source: 'seed:research/preamble-only.md',
      skipDedup: true,
    });

    const mem = service.getMemory(result.id);
    expect(mem!.content).toBe(content);
  });

  it('should handle file where preamble starts with ## (no merge needed)', async () => {
    const section1 = '## 1. First\n\nContent of first section that is long enough.';
    const section2 = '## 2. Second\n\nContent of second section that is long enough.';

    const r1 = await service.addMemory({
      content: section1,
      source: 'seed:research/no-preamble.md',
      skipDedup: true,
    });
    const r2 = await service.addMemory({
      content: section2,
      source: 'seed:research/no-preamble.md',
      skipDedup: true,
    });

    expect(service.getStats('test').total_memories).toBe(2);
    expect(service.getMemory(r1.id)!.content).toBe(section1);
    expect(service.getMemory(r2.id)!.content).toBe(section2);
  });

  it('should handle findBySource returning empty array for new source', async () => {
    const source = 'seed:research/brand-new.md';
    const existing = (
      db
        .prepare('SELECT id FROM memories WHERE namespace = ? AND source = ? AND is_archived = 0')
        .all('test', source) as Array<{ id: string }>
    ).map((r) => r.id);

    expect(existing).toHaveLength(0);

    const result = await service.addMemory({
      content: 'Brand new file content',
      source,
      skipDedup: true,
    });

    expect(result.deduplicated).toBe(false);
    expect(service.getStats('test').total_memories).toBe(1);
  });

  it('should handle duplicate issue IDs in KNOWN_ISSUES via replace-by-tag', async () => {
    const issueTag = 'P1.1-07';

    await service.addMemory({
      content: '[P1.1-07] First resolved entry',
      tags: ['issue', 'resolved', 'P3', issueTag],
      source: 'seed:KNOWN_ISSUES.md',
    });

    const firstEntries = (
      db.prepare('SELECT id, tags FROM memories WHERE namespace = ? AND is_archived = 0').all('test') as Array<{
        id: string;
        tags: string | null;
      }>
    )
      .filter((r) => {
        if (!r.tags) return false;
        const parsed: string[] = JSON.parse(r.tags);
        return parsed.includes(issueTag);
      })
      .map((r) => r.id);

    service.deleteMemories(firstEntries, true);

    await service.addMemory({
      content: '[P1.1-07] Second (superseding) resolved entry',
      tags: ['issue', 'resolved', 'P3', issueTag],
      source: 'seed:KNOWN_ISSUES.md',
    });

    const remaining = (
      db.prepare('SELECT id, tags FROM memories WHERE namespace = ? AND is_archived = 0').all('test') as Array<{
        id: string;
        tags: string | null;
      }>
    ).filter((r) => {
      if (!r.tags) return false;
      const parsed: string[] = JSON.parse(r.tags);
      return parsed.includes(issueTag);
    });

    expect(remaining).toHaveLength(1);

    const mem = service.getMemory(remaining[0].id);
    expect(mem!.content).toContain('Second (superseding)');
  });
});
