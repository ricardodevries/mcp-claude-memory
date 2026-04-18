import type Database from 'better-sqlite3';
import type { MemoryServerConfig } from '../config.js';
import type { Memory, MemoryRow, MemoryType, SearchResult } from '../types.js';
import { rowToMemory } from '../types.js';
import { embed } from './embedder.js';

const RRF_K = 60;

export class SearchService {
  constructor(
    private db: Database.Database,
    private config: MemoryServerConfig,
  ) {}

  async search(options: {
    query: string;
    namespace?: string;
    context_layer?: number[];
    memory_type?: MemoryType[];
    importance_min?: number;
    tags?: string[];
    limit?: number;
    threshold?: number;
    search_mode?: 'hybrid' | 'semantic' | 'lexical';
  }): Promise<SearchResult[]> {
    const ns = options.namespace ?? this.config.namespace;
    const limit = Math.min(options.limit ?? 10, 50);
    const threshold = options.threshold ?? 0.0;
    const mode = options.search_mode ?? 'hybrid';
    const candidateLimit = limit * 3;

    let vectorResults: Array<{ id: string; score: number }> = [];
    let ftsResults: Array<{ id: string; score: number }> = [];

    if (mode === 'hybrid' || mode === 'semantic') {
      vectorResults = await this.vectorSearch(options.query, ns, candidateLimit);
    }

    if (mode === 'hybrid' || mode === 'lexical') {
      ftsResults = this.ftsSearch(options.query, ns, candidateLimit);
    }

    let merged: Array<{ id: string; score: number }>;
    if (mode === 'hybrid') {
      merged = this.rrfMerge(vectorResults, ftsResults);
    } else if (mode === 'semantic') {
      merged = vectorResults;
    } else {
      merged = ftsResults;
    }

    merged = merged.filter((r) => r.score >= threshold);

    const filtered = this.applyFilters(merged, options);

    const results: SearchResult[] = [];
    for (const item of filtered.slice(0, limit)) {
      const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(item.id) as MemoryRow | undefined;
      if (row) {
        const memory = rowToMemory(row);
        results.push({ ...memory, relevance: item.score });

        this.db
          .prepare("UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?")
          .run(item.id);
      }
    }

    return results;
  }

  private async vectorSearch(
    query: string,
    namespace: string,
    limit: number,
  ): Promise<Array<{ id: string; score: number }>> {
    const embedding = await embed(query);

    try {
      const rows = this.db
        .prepare(
          `
        SELECT memory_id, distance
        FROM memory_embeddings
        WHERE embedding MATCH ?
        AND k = ?
      `,
        )
        .all(Buffer.from(embedding.buffer), limit) as any[];

      return rows
        .filter((r) => {
          const mem = this.db
            .prepare('SELECT namespace, is_archived FROM memories WHERE id = ?')
            .get(r.memory_id) as any;
          return mem && mem.namespace === namespace && mem.is_archived === 0;
        })
        .map((r, i) => ({
          id: r.memory_id,
          score: 1 / (RRF_K + i + 1),
        }));
    } catch {
      return [];
    }
  }

  private ftsSearch(query: string, namespace: string, limit: number): Array<{ id: string; score: number }> {
    const sanitized = query.replace(/[^\w\s]/g, ' ').trim();
    if (!sanitized) return [];

    try {
      const rows = this.db
        .prepare(
          `
        SELECT m.id, rank
        FROM memory_fts f
        JOIN memories m ON m.rowid = f.rowid
        WHERE memory_fts MATCH ?
        AND m.namespace = ?
        AND m.is_archived = 0
        ORDER BY rank
        LIMIT ?
      `,
        )
        .all(sanitized, namespace, limit) as any[];

      return rows.map((r, i) => ({
        id: r.id,
        score: 1 / (RRF_K + i + 1),
      }));
    } catch {
      return [];
    }
  }

  private rrfMerge(
    vectorResults: Array<{ id: string; score: number }>,
    ftsResults: Array<{ id: string; score: number }>,
  ): Array<{ id: string; score: number }> {
    const scores = new Map<string, number>();

    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i + 1));
    }

    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i];
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i + 1));
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score);
  }

  private applyFilters(
    results: Array<{ id: string; score: number }>,
    options: {
      context_layer?: number[];
      memory_type?: MemoryType[];
      importance_min?: number;
      tags?: string[];
    },
  ): Array<{ id: string; score: number }> {
    if (
      !options.context_layer?.length &&
      !options.memory_type?.length &&
      options.importance_min === undefined &&
      !options.tags?.length
    ) {
      return results;
    }

    return results.filter((r) => {
      const row = this.db
        .prepare('SELECT context_layer, memory_type, importance, tags FROM memories WHERE id = ?')
        .get(r.id) as any;
      if (!row) return false;

      if (options.context_layer?.length && !options.context_layer.includes(row.context_layer)) {
        return false;
      }
      if (options.memory_type?.length && !options.memory_type.includes(row.memory_type)) {
        return false;
      }
      if (options.importance_min !== undefined && row.importance < options.importance_min) {
        return false;
      }
      if (options.tags?.length) {
        const memTags: string[] = row.tags ? JSON.parse(row.tags) : [];
        if (!options.tags.every((t) => memTags.includes(t))) return false;
      }

      return true;
    });
  }
}
