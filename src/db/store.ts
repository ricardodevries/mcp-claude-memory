import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryServerConfig } from '../config.js';
import { runMigrations } from './migrations.js';

export function createStore(config: MemoryServerConfig): Database.Database {
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const db = new Database(config.dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  sqliteVec.load(db);

  runMigrations(db);

  createVecTable(db, config.embeddingDimensions);

  return db;
}

function createVecTable(db: Database.Database, dimensions: number): void {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_embeddings'").get();

  if (!exists) {
    db.exec(
      `CREATE VIRTUAL TABLE memory_embeddings USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[${dimensions}] distance_metric=cosine)`,
    );
  }
}
