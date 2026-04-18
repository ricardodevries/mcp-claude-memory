-- Initial schema: memories, sessions, relations, FTS5

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  content       TEXT NOT NULL,
  memory_type   TEXT NOT NULL DEFAULT 'observation',
  context_layer INTEGER NOT NULL DEFAULT 2 CHECK (context_layer BETWEEN 0 AND 3),
  importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source        TEXT,
  namespace     TEXT NOT NULL DEFAULT 'default',
  tags          TEXT,
  metadata      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  accessed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  access_count  INTEGER NOT NULL DEFAULT 0,
  expires_at    TEXT,
  superseded_by TEXT REFERENCES memories(id),
  is_archived   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(context_layer);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(is_archived) WHERE is_archived = 0;

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  namespace   TEXT NOT NULL DEFAULT 'default',
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT,
  summary     TEXT,
  metadata    TEXT
);

CREATE TABLE IF NOT EXISTS session_memories (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  memory_id  TEXT NOT NULL REFERENCES memories(id),
  relevance  REAL,
  PRIMARY KEY (session_id, memory_id)
);

CREATE TABLE IF NOT EXISTS relations (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id     TEXT NOT NULL REFERENCES memories(id),
  target_id     TEXT NOT NULL REFERENCES memories(id),
  relation_type TEXT NOT NULL,
  namespace     TEXT NOT NULL DEFAULT 'default',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  metadata      TEXT,
  UNIQUE(source_id, target_id, relation_type)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  memory_type,
  tags,
  source,
  tokenize='porter unicode61'
);
