import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestConfig, createTestDb, ensureEmbedder } from './helpers.js';
import { MemoryService } from '../src/services/memory.js';
import { SessionService } from '../src/services/session.js';
import type { MemoryServerConfig } from '../src/config.js';

let config: MemoryServerConfig;
let db: Database.Database;
let memService: MemoryService;
let sessionService: SessionService;

beforeAll(async () => {
  config = createTestConfig();
  await ensureEmbedder(config);
});

beforeEach(async () => {
  db = createTestDb(config);
  memService = new MemoryService(db, config);
  sessionService = new SessionService(db, config);

  await memService.addMemory({
    content: 'Never skip build or test steps',
    memory_type: 'rule',
    context_layer: 0,
    importance: 5,
  });
  await memService.addMemory({
    content: 'Always validate user input at system boundaries',
    memory_type: 'rule',
    context_layer: 0,
    importance: 5,
  });
  await memService.addMemory({
    content: 'Current phase is 2.1 project scaffold',
    memory_type: 'session_summary',
    context_layer: 1,
    importance: 4,
  });
  await memService.addMemory({
    content: 'Chose xUnit v3 for testing framework',
    memory_type: 'decision',
    context_layer: 1,
    importance: 4,
  });
  await memService.addMemory({
    content: 'sqlite-vec supports KNN with sub-75ms latency',
    memory_type: 'research',
    context_layer: 2,
    importance: 3,
  });
  await memService.addMemory({
    content: 'TODO: verify SmtpClient STARTTLS support',
    memory_type: 'scratchpad',
    context_layer: 3,
    importance: 1,
  });
});

afterEach(() => {
  db.close();
});

describe('SessionService', () => {
  describe('startSession', () => {
    it('should create a session and return an id', () => {
      const id = sessionService.startSession();
      expect(id).toBeDefined();
      expect(id).toHaveLength(32);
    });

    it('should store session metadata', () => {
      const id = sessionService.startSession({
        metadata: { project: 'ShardHub' },
      });
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
      expect(session).toBeDefined();
      expect(JSON.parse(session.metadata)).toEqual({
        project: 'ShardHub',
      });
    });
  });

  describe('endSession', () => {
    it('should set ended_at and summary', () => {
      const id = sessionService.startSession();
      sessionService.endSession(id, { summary: 'Completed testing' });

      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
      expect(session.ended_at).toBeDefined();
      expect(session.summary).toBe('Completed testing');
    });

    it('should promote specified scratchpad memories to L2', async () => {
      const scratch = await memService.addMemory({
        content: 'Promote me from scratchpad',
        context_layer: 3,
      });

      const sessionId = sessionService.startSession();
      sessionService.endSession(sessionId, {
        promote_scratchpad: [scratch.id],
      });

      const mem = memService.getMemory(scratch.id);
      expect(mem!.context_layer).toBe(2);
    });

    it('should expire non-promoted scratchpad memories', async () => {
      const keepId = (
        await memService.addMemory({
          content: 'Keep this scratchpad',
          context_layer: 3,
        })
      ).id;
      const expireId = (
        await memService.addMemory({
          content: 'Expire this scratchpad',
          context_layer: 3,
        })
      ).id;

      const sessionId = sessionService.startSession();
      sessionService.endSession(sessionId, {
        promote_scratchpad: [keepId],
      });

      const expired = db.prepare('SELECT expires_at FROM memories WHERE id = ?').get(expireId) as any;
      expect(expired.expires_at).not.toBeNull();
    });
  });

  describe('getBriefing', () => {
    it('should return L0 rules in the briefing', async () => {
      const briefing = await sessionService.getBriefing();
      expect(briefing.rules.length).toBeGreaterThanOrEqual(1);
      expect(briefing.rules.every((r) => r.context_layer === 0)).toBe(true);
    });

    it('should return L1 state in the briefing', async () => {
      const briefing = await sessionService.getBriefing();
      expect(briefing.state.length).toBeGreaterThanOrEqual(1);
      expect(briefing.state.every((r) => r.context_layer === 1)).toBe(true);
    });

    it('should return query-relevant L2 memories when query is provided', async () => {
      const briefing = await sessionService.getBriefing({
        query: 'vector search performance',
      });
      expect(briefing.relevant.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty relevant when no query is provided', async () => {
      const briefing = await sessionService.getBriefing();
      expect(briefing.relevant).toHaveLength(0);
    });

    it('should include token count', async () => {
      const briefing = await sessionService.getBriefing();
      expect(briefing.token_count).toBeGreaterThan(0);
    });

    it('should respect token budget', async () => {
      const briefing = await sessionService.getBriefing({
        token_budget: 10,
      });
      expect(briefing.token_count).toBeLessThanOrEqual(15);
    });

    it('should include recent session summaries', async () => {
      const id = sessionService.startSession();
      sessionService.endSession(id, { summary: 'Previous session work' });

      const briefing = await sessionService.getBriefing();
      expect(briefing.recent_sessions.length).toBeGreaterThanOrEqual(1);
      expect(briefing.recent_sessions[0].summary).toBe('Previous session work');
    });
  });

  describe('getContextLayers', () => {
    it('should return all four layers', () => {
      const result = sessionService.getContextLayers();
      expect(result.layers).toHaveProperty('L0');
      expect(result.layers).toHaveProperty('L1');
      expect(result.layers).toHaveProperty('L2');
      expect(result.layers).toHaveProperty('L3');
    });

    it('should respect layer budgets', () => {
      const result = sessionService.getContextLayers();
      for (const key of ['L0', 'L1', 'L2', 'L3'] as const) {
        expect(result.layers[key].token_count).toBeLessThanOrEqual(result.layers[key].budget);
      }
    });

    it('should only include requested layers', () => {
      const result = sessionService.getContextLayers({ layers: [0, 1] });
      expect(result.layers.L0.memories.length).toBeGreaterThanOrEqual(1);
      expect(result.layers.L1.memories.length).toBeGreaterThanOrEqual(1);
      expect(result.layers.L2.memories).toHaveLength(0);
      expect(result.layers.L3.memories).toHaveLength(0);
    });

    it('should override token budgets', () => {
      const result = sessionService.getContextLayers({
        token_budget: { L0: 5, L1: 5, L2: 5, L3: 5 },
      });
      expect(result.layers.L0.budget).toBe(5);
      expect(result.layers.L1.budget).toBe(5);
    });

    it('should report total tokens and budget', () => {
      const result = sessionService.getContextLayers();
      expect(result.total_tokens).toBeGreaterThan(0);
      expect(result.total_budget).toBe(
        config.tokenBudgets.L0 + config.tokenBudgets.L1 + config.tokenBudgets.L2 + config.tokenBudgets.L3,
      );
    });
  });
});
