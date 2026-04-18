-- Track content changes: store previous version before update_memory overwrites content.

CREATE TABLE IF NOT EXISTS memory_versions (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  memory_id   TEXT NOT NULL REFERENCES memories(id),
  content     TEXT NOT NULL,
  changed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id, version DESC);
