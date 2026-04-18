import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations, getCurrentVersion, discoverMigrations } from '../src/db/migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

let db: Database.Database;

afterEach(() => {
  if (db) db.close();
});

describe('migrations', () => {
  describe('discoverMigrations', () => {
    it('should find SQL files in the migrations directory', () => {
      const migrations = discoverMigrations(MIGRATIONS_DIR);
      expect(migrations.length).toBeGreaterThanOrEqual(1);
      expect(migrations[0].version).toBe(1);
      expect(migrations[0].filename).toBe('001_initial.sql');
      expect(migrations[0].sql).toContain('CREATE TABLE');
    });

    it('should sort migrations by filename', () => {
      const migrations = discoverMigrations(MIGRATIONS_DIR);
      for (let i = 1; i < migrations.length; i++) {
        expect(migrations[i].version).toBeGreaterThan(migrations[i - 1].version);
      }
    });
  });

  describe('runMigrations', () => {
    it('should create all tables on fresh database', () => {
      db = new Database(':memory:');
      sqliteVec.load(db);
      runMigrations(db, MIGRATIONS_DIR);

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('memories');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('session_memories');
      expect(tableNames).toContain('relations');
      expect(tableNames).toContain('schema_version');
    });

    it('should create FTS5 virtual table', () => {
      db = new Database(':memory:');
      sqliteVec.load(db);
      runMigrations(db, MIGRATIONS_DIR);

      const fts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get();
      expect(fts).toBeDefined();
    });

    it('should record version in schema_version table', () => {
      db = new Database(':memory:');
      sqliteVec.load(db);
      runMigrations(db, MIGRATIONS_DIR);

      const version = getCurrentVersion(db);
      expect(version).toBe(2);
    });

    it('should be idempotent (running twice is safe)', () => {
      db = new Database(':memory:');
      sqliteVec.load(db);
      runMigrations(db, MIGRATIONS_DIR);
      runMigrations(db, MIGRATIONS_DIR);

      const version = getCurrentVersion(db);
      expect(version).toBe(2);

      const rows = db.prepare('SELECT * FROM schema_version').all();
      expect(rows).toHaveLength(2);
    });

    it('should create indexes on the memories table', () => {
      db = new Database(':memory:');
      sqliteVec.load(db);
      runMigrations(db, MIGRATIONS_DIR);

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'")
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_memories_layer');
      expect(indexNames).toContain('idx_memories_type');
      expect(indexNames).toContain('idx_memories_namespace');
      expect(indexNames).toContain('idx_memories_importance');
      expect(indexNames).toContain('idx_memories_created');
      expect(indexNames).toContain('idx_memories_expires');
      expect(indexNames).toContain('idx_memories_archived');
    });
  });

  describe('getCurrentVersion', () => {
    it('should return 0 for a fresh database with no schema_version table', () => {
      db = new Database(':memory:');
      const version = getCurrentVersion(db);
      expect(version).toBe(0);
    });
  });

  describe('schema constraints', () => {
    it('should enforce context_layer CHECK constraint (0-3)', () => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      sqliteVec.load(db);
      runMigrations(db, MIGRATIONS_DIR);

      expect(() => {
        db.prepare(
          "INSERT INTO memories (id, content, context_layer, namespace) VALUES ('bad', 'test', 4, 'test')",
        ).run();
      }).toThrow();
    });

    it('should enforce importance CHECK constraint (1-5)', () => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      sqliteVec.load(db);
      runMigrations(db, MIGRATIONS_DIR);

      expect(() => {
        db.prepare("INSERT INTO memories (id, content, importance, namespace) VALUES ('bad', 'test', 6, 'test')").run();
      }).toThrow();
    });

    it('should enforce unique constraint on relations', () => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      sqliteVec.load(db);
      runMigrations(db, MIGRATIONS_DIR);

      db.prepare("INSERT INTO memories (id, content, namespace) VALUES ('a', 'source', 'test')").run();
      db.prepare("INSERT INTO memories (id, content, namespace) VALUES ('b', 'target', 'test')").run();
      db.prepare(
        "INSERT INTO relations (id, source_id, target_id, relation_type, namespace) VALUES ('r1', 'a', 'b', 'related_to', 'test')",
      ).run();

      expect(() => {
        db.prepare(
          "INSERT INTO relations (id, source_id, target_id, relation_type, namespace) VALUES ('r2', 'a', 'b', 'related_to', 'test')",
        ).run();
      }).toThrow();
    });
  });
});
