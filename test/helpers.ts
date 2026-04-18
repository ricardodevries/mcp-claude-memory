import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initEmbedder } from '../src/services/embedder.js';
import { runMigrations } from '../src/db/migrations.js';
import type { MemoryServerConfig } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');
const MODEL_CACHE = resolve(__dirname, '..', 'models');

let embedderReady = false;

export function createTestConfig(overrides: Partial<MemoryServerConfig> = {}): MemoryServerConfig {
  return {
    dbPath: ':memory:',
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    embeddingDimensions: 384,
    modelCacheDir: MODEL_CACHE,
    tokenBudgets: { L0: 2000, L1: 4000, L2: 6000, L3: 2000 },
    dedup: {
      writeThreshold: 0.92,
      mergeThreshold: 0.95,
      relatedThreshold: 0.8,
    },
    namespace: 'test',
    ...overrides,
  };
}

export function createTestDb(config: MemoryServerConfig): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  runMigrations(db, MIGRATIONS_DIR);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[${config.embeddingDimensions}] distance_metric=cosine)`,
  );
  return db;
}

export async function ensureEmbedder(config: MemoryServerConfig): Promise<void> {
  if (embedderReady) return;
  await initEmbedder(config);
  embedderReady = true;
}
