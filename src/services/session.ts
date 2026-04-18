import type Database from 'better-sqlite3';
import type { MemoryServerConfig } from '../config.js';
import type { Memory, MemoryRow, Briefing, SessionSummary } from '../types.js';
import { rowToMemory, estimateTokens } from '../types.js';
import { SearchService } from './search.js';

export class SessionService {
  private searchService: SearchService;

  constructor(
    private db: Database.Database,
    private config: MemoryServerConfig,
  ) {
    this.searchService = new SearchService(db, config);
  }

  startSession(
    options: {
      namespace?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): string {
    const id = this.generateId();
    const ns = options.namespace ?? this.config.namespace;

    this.db
      .prepare(
        `
      INSERT INTO sessions (id, namespace, metadata)
      VALUES (?, ?, ?)
    `,
      )
      .run(id, ns, options.metadata ? JSON.stringify(options.metadata) : null);

    return id;
  }

  endSession(
    sessionId: string,
    options: {
      summary?: string;
      promote_scratchpad?: string[];
    } = {},
  ): void {
    this.db
      .prepare(
        `
      UPDATE sessions SET ended_at = datetime('now'), summary = ? WHERE id = ?
    `,
      )
      .run(options.summary ?? null, sessionId);

    if (options.promote_scratchpad?.length) {
      const update = this.db.prepare(
        "UPDATE memories SET context_layer = 2, updated_at = datetime('now') WHERE id = ? AND context_layer = 3",
      );
      for (const memId of options.promote_scratchpad) {
        update.run(memId);
      }
    }

    const session = this.db.prepare('SELECT namespace FROM sessions WHERE id = ?').get(sessionId) as any;
    if (session) {
      this.db
        .prepare(
          `
        UPDATE memories SET expires_at = datetime('now'), updated_at = datetime('now')
        WHERE context_layer = 3 AND namespace = ? AND expires_at IS NULL AND is_archived = 0
        AND id NOT IN (${(options.promote_scratchpad ?? []).map(() => '?').join(',') || "''"})
      `,
        )
        .run(session.namespace, ...(options.promote_scratchpad ?? []));
    }
  }

  async getBriefing(
    options: {
      namespace?: string;
      query?: string;
      token_budget?: number;
    } = {},
  ): Promise<Briefing> {
    const ns = options.namespace ?? this.config.namespace;
    const totalBudget = options.token_budget ?? 6000;

    const budgets = {
      rules: Math.floor(totalBudget * 0.2),
      state: Math.floor(totalBudget * 0.35),
      relevant: Math.floor(totalBudget * 0.35),
      sessions: Math.floor(totalBudget * 0.1),
    };

    const rules = this.getLayerMemories(ns, 0, budgets.rules);
    const state = this.getLayerMemories(ns, 1, budgets.state);

    let relevant: Memory[] = [];
    if (options.query) {
      const results = await this.searchService.search({
        query: options.query,
        namespace: ns,
        context_layer: [2],
        limit: 20,
      });
      relevant = this.fitToBudget(results, budgets.relevant);
    }

    const recentSessions = this.getRecentSessions(ns, 5);

    const tokenCount =
      this.countTokens(rules) +
      this.countTokens(state) +
      this.countTokens(relevant) +
      recentSessions.reduce((sum, s) => sum + estimateTokens(s.summary ?? ''), 0);

    return {
      rules,
      state,
      relevant,
      recent_sessions: recentSessions,
      token_count: tokenCount,
    };
  }

  getContextLayers(
    options: {
      namespace?: string;
      layers?: number[];
      token_budget?: {
        L0?: number;
        L1?: number;
        L2?: number;
        L3?: number;
      };
      query?: string;
    } = {},
  ): {
    layers: Record<string, { memories: Memory[]; token_count: number; budget: number }>;
    total_tokens: number;
    total_budget: number;
  } {
    const ns = options.namespace ?? this.config.namespace;
    const includeLayers = options.layers ?? [0, 1, 2, 3];

    const budgets = {
      L0: options.token_budget?.L0 ?? this.config.tokenBudgets.L0,
      L1: options.token_budget?.L1 ?? this.config.tokenBudgets.L1,
      L2: options.token_budget?.L2 ?? this.config.tokenBudgets.L2,
      L3: options.token_budget?.L3 ?? this.config.tokenBudgets.L3,
    };

    const result: Record<string, { memories: Memory[]; token_count: number; budget: number }> = {};
    let totalTokens = 0;
    let totalBudget = 0;

    for (const layer of [0, 1, 2, 3] as const) {
      const key = `L${layer}` as keyof typeof budgets;
      const budget = budgets[key];
      totalBudget += budget;

      if (!includeLayers.includes(layer)) {
        result[key] = { memories: [], token_count: 0, budget };
        continue;
      }

      const memories = this.getLayerMemories(ns, layer, budget);
      const tokenCount = this.countTokens(memories);
      totalTokens += tokenCount;

      result[key] = { memories, token_count: tokenCount, budget };
    }

    return {
      layers: result,
      total_tokens: totalTokens,
      total_budget: totalBudget,
    };
  }

  private getLayerMemories(namespace: string, layer: number, tokenBudget: number): Memory[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM memories
      WHERE namespace = ? AND context_layer = ? AND is_archived = 0
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY importance DESC, created_at DESC
    `,
      )
      .all(namespace, layer) as MemoryRow[];

    const memories = rows.map(rowToMemory);
    return this.fitToBudget(memories, tokenBudget);
  }

  private fitToBudget(memories: Memory[], budget: number): Memory[] {
    const result: Memory[] = [];
    let tokens = 0;

    for (const mem of memories) {
      const memTokens = estimateTokens(mem.content);
      if (tokens + memTokens > budget) break;
      result.push(mem);
      tokens += memTokens;
    }

    return result;
  }

  private countTokens(memories: Memory[]): number {
    return memories.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  private getRecentSessions(namespace: string, limit: number): SessionSummary[] {
    return this.db
      .prepare(
        `
      SELECT id, started_at, ended_at, summary
      FROM sessions
      WHERE namespace = ? AND ended_at IS NOT NULL
      ORDER BY ended_at DESC
      LIMIT ?
    `,
      )
      .all(namespace, limit) as SessionSummary[];
  }

  private generateId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}
