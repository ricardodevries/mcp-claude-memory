import type Database from 'better-sqlite3';
import type { MemoryServerConfig } from '../config.js';
import type { CleanupResult } from '../types.js';

export class CleanupService {
  constructor(
    private db: Database.Database,
    private config: MemoryServerConfig,
  ) {}

  cleanup(
    options: {
      namespace?: string;
      dry_run?: boolean;
    } = {},
  ): CleanupResult {
    const ns = options.namespace ?? this.config.namespace;
    const dryRun = options.dry_run ?? false;

    const expired = this.cleanExpired(ns, dryRun);
    const merged = this.mergeNearDuplicates(ns, dryRun);
    const archived = this.archiveOldScratchpad(ns, dryRun);
    const promoted = this.promoteFrequentlyAccessed(ns, dryRun);
    const decayed = this.decayStaleMemories(ns, dryRun);

    return { expired, merged, archived, promoted, decayed };
  }

  private cleanExpired(namespace: string, dryRun: boolean): number {
    const count = (
      this.db
        .prepare(
          `
      SELECT COUNT(*) as count FROM memories
      WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= datetime('now') AND is_archived = 0
    `,
        )
        .get(namespace) as any
    ).count;

    if (!dryRun && count > 0) {
      this.db
        .prepare(
          `
        UPDATE memories SET is_archived = 1, updated_at = datetime('now')
        WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= datetime('now') AND is_archived = 0
      `,
        )
        .run(namespace);
    }

    return count;
  }

  private mergeNearDuplicates(namespace: string, dryRun: boolean): number {
    const memories = this.db
      .prepare(
        `
      SELECT id FROM memories
      WHERE namespace = ? AND is_archived = 0
      ORDER BY importance DESC, created_at DESC
    `,
      )
      .all(namespace) as any[];

    let merged = 0;
    const processed = new Set<string>();

    for (const mem of memories) {
      if (processed.has(mem.id)) continue;

      try {
        const embedding = this.db
          .prepare('SELECT embedding FROM memory_embeddings WHERE memory_id = ?')
          .get(mem.id) as any;

        if (!embedding) continue;

        const similar = this.db
          .prepare(
            `
          SELECT memory_id, distance
          FROM memory_embeddings
          WHERE embedding MATCH ?
          AND k = 5
        `,
          )
          .all(embedding.embedding) as any[];

        for (const s of similar) {
          if (s.memory_id === mem.id || processed.has(s.memory_id)) continue;

          const similarity = 1 - s.distance;
          if (similarity >= this.config.dedup.mergeThreshold) {
            const target = this.db
              .prepare('SELECT namespace, is_archived FROM memories WHERE id = ?')
              .get(s.memory_id) as any;
            if (!target || target.namespace !== namespace || target.is_archived) continue;

            if (!dryRun) {
              this.db
                .prepare(
                  `
                UPDATE memories SET is_archived = 1, superseded_by = ?, updated_at = datetime('now')
                WHERE id = ?
              `,
                )
                .run(mem.id, s.memory_id);

              try {
                this.db
                  .prepare(
                    `
                  INSERT INTO relations (id, source_id, target_id, relation_type, namespace)
                  VALUES (?, ?, ?, 'supersedes', ?)
                `,
                  )
                  .run(this.generateId(), mem.id, s.memory_id, namespace);
              } catch {
                /* ignore unique constraint */
              }
            }

            processed.add(s.memory_id);
            merged++;
          }
        }
      } catch {
        continue;
      }
    }

    return merged;
  }

  private archiveOldScratchpad(namespace: string, dryRun: boolean): number {
    const count = (
      this.db
        .prepare(
          `
      SELECT COUNT(*) as count FROM memories
      WHERE namespace = ? AND context_layer = 3 AND is_archived = 0
      AND created_at < datetime('now', '-24 hours')
    `,
        )
        .get(namespace) as any
    ).count;

    if (!dryRun && count > 0) {
      this.db
        .prepare(
          `
        UPDATE memories SET is_archived = 1, updated_at = datetime('now')
        WHERE namespace = ? AND context_layer = 3 AND is_archived = 0
        AND created_at < datetime('now', '-24 hours')
      `,
        )
        .run(namespace);
    }

    return count;
  }

  private promoteFrequentlyAccessed(namespace: string, dryRun: boolean): number {
    const candidates = this.db
      .prepare(
        `
      SELECT id, importance, access_count FROM memories
      WHERE namespace = ? AND is_archived = 0 AND importance < 5
      AND access_count >= ?
    `,
      )
      .all(namespace, 10) as Array<{
      id: string;
      importance: number;
      access_count: number;
    }>;

    let promoted = 0;
    for (const mem of candidates) {
      const newImportance = Math.min(5, mem.importance + Math.floor(mem.access_count / 10));
      if (newImportance <= mem.importance) continue;

      if (!dryRun) {
        this.db
          .prepare(`UPDATE memories SET importance = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(newImportance, mem.id);
      }
      promoted++;
    }

    return promoted;
  }

  private decayStaleMemories(namespace: string, dryRun: boolean): number {
    const count = (
      this.db
        .prepare(
          `
      SELECT COUNT(*) as count FROM memories
      WHERE namespace = ? AND is_archived = 0 AND importance > 1
      AND context_layer > 0
      AND accessed_at < datetime('now', '-30 days')
    `,
        )
        .get(namespace) as any
    ).count;

    if (!dryRun && count > 0) {
      this.db
        .prepare(
          `
        UPDATE memories SET importance = importance - 1, updated_at = datetime('now')
        WHERE namespace = ? AND is_archived = 0 AND importance > 1
        AND context_layer > 0
        AND accessed_at < datetime('now', '-30 days')
      `,
        )
        .run(namespace);
    }

    return count;
  }

  private generateId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}
