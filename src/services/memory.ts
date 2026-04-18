import type Database from 'better-sqlite3';
import type { MemoryServerConfig } from '../config.js';
import type { Memory, MemoryRow, MemoryType, ContextLayer, Relation, RelationType } from '../types.js';
import { rowToMemory } from '../types.js';
import { embed } from './embedder.js';

export class MemoryService {
  constructor(
    private db: Database.Database,
    private config: MemoryServerConfig,
  ) {}

  async addMemory(input: {
    content: string;
    memory_type?: MemoryType;
    context_layer?: ContextLayer;
    importance?: number;
    source?: string;
    namespace?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    expires_at?: string;
    skipDedup?: boolean;
  }): Promise<{ id: string; deduplicated: boolean; existing_id?: string }> {
    const ns = input.namespace ?? this.config.namespace;
    const embedding = await embed(input.content);

    const similar = this.findSimilarByVector(embedding, ns, 5);
    if (!input.skipDedup) {
      for (const match of similar) {
        if (match.similarity >= this.config.dedup.writeThreshold) {
          this.db
            .prepare("UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?")
            .run(match.id);
          return {
            id: match.id,
            deduplicated: true,
            existing_id: match.id,
          };
        }
      }
    }

    const id = this.generateId();
    const tagsJson = input.tags ? JSON.stringify(input.tags) : null;
    const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;

    this.db
      .prepare(
        `
      INSERT INTO memories (id, content, memory_type, context_layer, importance, source, namespace, tags, metadata, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.content,
        input.memory_type ?? 'observation',
        input.context_layer ?? 2,
        input.importance ?? 3,
        input.source ?? null,
        ns,
        tagsJson,
        metaJson,
        input.expires_at ?? null,
      );

    this.insertEmbedding(id, embedding);
    this.insertFts(id, input.content, input.memory_type ?? 'observation', tagsJson, input.source ?? null);

    for (const match of similar) {
      if (match.similarity >= this.config.dedup.relatedThreshold) {
        this.addRelation({
          source_id: id,
          target_id: match.id,
          relation_type: 'related_to',
          namespace: ns,
        });
      }
    }

    return { id, deduplicated: false };
  }

  getMemory(id: string): Memory | null {
    this.db
      .prepare("UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?")
      .run(id);

    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) return null;

    return rowToMemory(row);
  }

  async updateMemory(
    id: string,
    updates: {
      content?: string;
      memory_type?: MemoryType;
      context_layer?: ContextLayer;
      importance?: number;
      tags?: string[];
      metadata?: Record<string, unknown>;
      expires_at?: string | null;
    },
  ): Promise<Memory | null> {
    const existing = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!existing) return null;

    const sets: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    if (updates.content !== undefined) {
      sets.push('content = ?');
      params.push(updates.content);
    }
    if (updates.memory_type !== undefined) {
      sets.push('memory_type = ?');
      params.push(updates.memory_type);
    }
    if (updates.context_layer !== undefined) {
      sets.push('context_layer = ?');
      params.push(updates.context_layer);
    }
    if (updates.importance !== undefined) {
      sets.push('importance = ?');
      params.push(updates.importance);
    }
    if (updates.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(updates.tags));
    }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
    }
    if (updates.expires_at !== undefined) {
      sets.push('expires_at = ?');
      params.push(updates.expires_at);
    }

    if (updates.content !== undefined && updates.content !== existing.content) {
      const currentVersion = (
        this.db.prepare('SELECT COALESCE(MAX(version), 0) as v FROM memory_versions WHERE memory_id = ?').get(id) as {
          v: number;
        }
      ).v;

      this.db
        .prepare('INSERT INTO memory_versions (id, memory_id, content, version) VALUES (?, ?, ?, ?)')
        .run(this.generateId(), id, existing.content, currentVersion + 1);
    }

    params.push(id);
    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    if (updates.content !== undefined) {
      await this.updateEmbedding(id, updates.content);
      this.updateFts(
        id,
        updates.content,
        updates.memory_type ?? existing.memory_type,
        updates.tags ? JSON.stringify(updates.tags) : existing.tags,
        existing.source,
      );
    }

    return this.getMemory(id);
  }

  deleteMemories(ids: string[], hard: boolean = false): number {
    let count = 0;
    const deleteOrArchive = hard
      ? this.db.prepare('DELETE FROM memories WHERE id = ?')
      : this.db.prepare("UPDATE memories SET is_archived = 1, updated_at = datetime('now') WHERE id = ?");

    const deleteEmbedding = this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?');
    const deleteFts = this.db.prepare('DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)');
    const deleteRelationsSource = this.db.prepare('DELETE FROM relations WHERE source_id = ?');
    const deleteRelationsTarget = this.db.prepare('DELETE FROM relations WHERE target_id = ?');
    const deleteSessionMemories = this.db.prepare('DELETE FROM session_memories WHERE memory_id = ?');
    const clearSupersededBy = this.db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?');
    const deleteVersions = this.db.prepare('DELETE FROM memory_versions WHERE memory_id = ?');

    for (const id of ids) {
      if (hard) {
        deleteVersions.run(id);
        deleteEmbedding.run(id);
        deleteFts.run(id);
        deleteRelationsSource.run(id);
        deleteRelationsTarget.run(id);
        deleteSessionMemories.run(id);
        clearSupersededBy.run(id);
      }
      const result = deleteOrArchive.run(id);
      if (result.changes > 0) {
        count++;
      }
    }
    return count;
  }

  listMemories(
    options: {
      namespace?: string;
      context_layer?: number[];
      memory_type?: MemoryType[];
      importance_min?: number;
      include_archived?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Memory[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    conditions.push('namespace = ?');
    params.push(options.namespace ?? this.config.namespace);

    if (!options.include_archived) {
      conditions.push('is_archived = 0');
    }

    if (options.context_layer?.length) {
      conditions.push(`context_layer IN (${options.context_layer.map(() => '?').join(',')})`);
      params.push(...options.context_layer);
    }

    if (options.memory_type?.length) {
      conditions.push(`memory_type IN (${options.memory_type.map(() => '?').join(',')})`);
      params.push(...options.memory_type);
    }

    if (options.importance_min !== undefined) {
      conditions.push('importance >= ?');
      params.push(options.importance_min);
    }

    const limit = Math.min(options.limit ?? 50, 100);
    const offset = options.offset ?? 0;

    const sql = `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY importance DESC, created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  addRelation(input: {
    source_id: string;
    target_id: string;
    relation_type: RelationType;
    namespace?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const id = this.generateId();
    try {
      this.db
        .prepare(
          `
        INSERT INTO relations (id, source_id, target_id, relation_type, namespace, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          input.source_id,
          input.target_id,
          input.relation_type,
          input.namespace ?? this.config.namespace,
          input.metadata ? JSON.stringify(input.metadata) : null,
        );
    } catch (e: any) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return id;
      throw e;
    }
    return id;
  }

  getRelations(
    memoryId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
    relationType?: string,
  ): Relation[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      conditions.push('source_id = ?');
      params.push(memoryId);
    }
    if (direction === 'incoming' || direction === 'both') {
      conditions.push('target_id = ?');
      params.push(memoryId);
    }

    let sql = `SELECT * FROM relations WHERE (${conditions.join(' OR ')})`;
    if (relationType) {
      sql += ' AND relation_type = ?';
      params.push(relationType);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  }

  getStats(namespace?: string): {
    total_memories: number;
    by_layer: Record<string, number>;
    by_type: Record<string, number>;
    db_size_bytes: number;
  } {
    const ns = namespace ?? this.config.namespace;

    const total = (
      this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE namespace = ? AND is_archived = 0').get(ns) as any
    ).count;

    const layerRows = this.db
      .prepare(
        'SELECT context_layer, COUNT(*) as count FROM memories WHERE namespace = ? AND is_archived = 0 GROUP BY context_layer',
      )
      .all(ns) as any[];

    const typeRows = this.db
      .prepare(
        'SELECT memory_type, COUNT(*) as count FROM memories WHERE namespace = ? AND is_archived = 0 GROUP BY memory_type',
      )
      .all(ns) as any[];

    const by_layer: Record<string, number> = {};
    for (const r of layerRows) by_layer[`L${r.context_layer}`] = r.count;

    const by_type: Record<string, number> = {};
    for (const r of typeRows) by_type[r.memory_type] = r.count;

    const pageCount = (this.db.pragma('page_count') as any[])[0].page_count;
    const pageSize = (this.db.pragma('page_size') as any[])[0].page_size;

    return {
      total_memories: total,
      by_layer,
      by_type,
      db_size_bytes: pageCount * pageSize,
    };
  }

  listNamespaces(): Array<{ namespace: string; memory_count: number }> {
    return this.db
      .prepare(
        'SELECT namespace, COUNT(*) as memory_count FROM memories WHERE is_archived = 0 GROUP BY namespace ORDER BY memory_count DESC',
      )
      .all() as Array<{ namespace: string; memory_count: number }>;
  }

  getMemoryVersions(memoryId: string): Array<{ version: number; content: string; changed_at: string }> {
    return this.db
      .prepare('SELECT version, content, changed_at FROM memory_versions WHERE memory_id = ? ORDER BY version DESC')
      .all(memoryId) as Array<{
      version: number;
      content: string;
      changed_at: string;
    }>;
  }

  findSimilarByVector(
    embedding: Float32Array,
    namespace: string,
    limit: number,
  ): Array<{ id: string; similarity: number }> {
    try {
      const results = this.db
        .prepare(
          `
        SELECT memory_id, distance
        FROM memory_embeddings
        WHERE embedding MATCH ?
        AND k = ?
      `,
        )
        .all(Buffer.from(embedding.buffer), limit) as any[];

      return results
        .filter((r) => {
          const mem = this.db
            .prepare('SELECT namespace, is_archived FROM memories WHERE id = ?')
            .get(r.memory_id) as any;
          return mem && mem.namespace === namespace && mem.is_archived === 0;
        })
        .map((r) => ({
          id: r.memory_id,
          similarity: 1 - r.distance,
        }));
    } catch (err) {
      return [];
    }
  }

  private insertEmbedding(id: string, embedding: Float32Array): void {
    this.db
      .prepare('INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)')
      .run(id, Buffer.from(embedding.buffer));
  }

  private async updateEmbedding(id: string, content: string): Promise<void> {
    const embedding = await embed(content);
    this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
    this.insertEmbedding(id, embedding);
  }

  private insertFts(id: string, content: string, memoryType: string, tags: string | null, source: string | null): void {
    this.db
      .prepare(
        'INSERT INTO memory_fts (rowid, content, memory_type, tags, source) VALUES ((SELECT rowid FROM memories WHERE id = ?), ?, ?, ?, ?)',
      )
      .run(id, content, memoryType, tags ?? '', source ?? '');
  }

  private updateFts(id: string, content: string, memoryType: string, tags: string | null, source: string | null): void {
    const rowid = (this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as any)?.rowid;
    if (rowid) {
      this.db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(rowid);
      this.db
        .prepare('INSERT INTO memory_fts (rowid, content, memory_type, tags, source) VALUES (?, ?, ?, ?, ?)')
        .run(rowid, content, memoryType, tags ?? '', source ?? '');
    }
  }

  private generateId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}
