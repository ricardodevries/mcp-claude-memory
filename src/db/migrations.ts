import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'migrations');

const SCHEMA_VERSION_DDL = `CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT
);`;

interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

export function discoverMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((filename) => {
    const match = filename.match(/^(\d+)/);
    if (!match) {
      throw new Error(`Migration file ${filename} does not start with a version number`);
    }
    return {
      version: parseInt(match[1], 10),
      filename,
      sql: readFileSync(resolve(dir, filename), 'utf-8'),
    };
  });
}

export function getCurrentVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

export function runMigrations(db: Database.Database, migrationsDir: string = MIGRATIONS_DIR): void {
  db.exec(SCHEMA_VERSION_DDL);

  const current = getCurrentVersion(db);
  const migrations = discoverMigrations(migrationsDir);
  const pending = migrations.filter((m) => m.version > current);

  if (pending.length === 0) return;

  const runAll = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(
        migration.version,
        migration.filename,
      );
    }
  });

  runAll();
}
