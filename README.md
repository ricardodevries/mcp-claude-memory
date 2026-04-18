# @ricardodevries/mcp-claude-memory

An MCP server that gives Claude Code persistent memory across sessions. Uses SQLite for storage, local embeddings via `all-MiniLM-L6-v2` (runs offline, no API keys needed), and hybrid search combining semantic vectors with full-text search.

## Setup

```bash
git clone https://github.com/ricardodevries/mcp-claude-memory .claude/mcp/mcp-claude-memory
cd .claude/mcp/mcp-claude-memory
npm install
npm run build
```

Then add to your project's `.mcp.json` (Claude Code starts the server automatically):

```json
{
  "mcpServers": {
    "claude-memory": {
      "type": "stdio",
      "command": "node",
      "args": [".claude/mcp/mcp-claude-memory/dist/index.js"],
      "env": {
        "MEMORY_DB_PATH": "./.claude/database/claude-memory.db"
      }
    }
  }
}
```

## Context Layers

Memories are organized into four layers with configurable token budgets:

| Layer | Name            | Budget       | Purpose                                       |
| ----- | --------------- | ------------ | --------------------------------------------- |
| L0    | Permanent Rules | 2,000 tokens | Immutable constraints, coding standards       |
| L1    | Session-Start   | 4,000 tokens | Project state, active decisions, known issues |
| L2    | Task-Specific   | 6,000 tokens | Retrieved on relevance match via search       |
| L3    | Ephemeral       | 2,000 tokens | Scratchpad, auto-expires on session end       |

### Core CRUD

**`add_memories`** — Store one or more memories with type, layer, importance, and tags.

```json
{
  "memories": [
    {
      "content": "All API responses must include request tracing headers",
      "memory_type": "rule",
      "context_layer": 0,
      "importance": 5,
      "source": "architect",
      "tags": ["api", "tracing"]
    }
  ]
}
```

Deduplication is automatic: if a new memory's embedding is above the write threshold (default 0.92 cosine similarity) against an existing memory, it won't be stored twice.

**`get_memory`** — Retrieve a single memory by ID.

```json
{ "id": "abc123..." }
```

**`update_memory`** — Update a memory's content or metadata. Content changes are versioned automatically (previous content is saved to `memory_versions` before overwriting). Metadata-only updates (importance, tags, etc.) don't create versions.

```json
{
  "id": "abc123...",
  "importance": 5,
  "tags": ["updated", "important"]
}
```

**`delete_memories`** — Soft-delete or hard-delete memories by ID.

```json
{
  "ids": ["abc123...", "def456..."],
  "hard": false
}
```

### Search

**`search_memories`** — Hybrid search across memories. The query is embedded and run against both a KNN vector index (sqlite-vec) and FTS5, then results are merged via Reciprocal Rank Fusion. Filterable by layer, type, importance, and namespace.

```json
{
  "query": "database connection pooling",
  "context_layer": [1, 2],
  "memory_type": ["decision", "observation"],
  "importance_min": 3,
  "limit": 10,
  "search_mode": "hybrid"
}
```

**`get_context_layers`** — Retrieve all memories for specific layers, respecting token budgets.

```json
{
  "layers": [0, 1],
  "token_budget": { "L0": 2000, "L1": 4000 }
}
```

### Sessions

**`start_session`** — Begin a session, optionally with a briefing tailored to a query.

```json
{
  "include_briefing": true,
  "query": "user authentication flow"
}
```

**`end_session`** — End a session. Generates a summary, archives L3 scratchpad memories (unless promoted).

```json
{
  "session_id": "...",
  "summary": "Completed migration to connection pooling with retry logic",
  "promote_scratchpad": ["memory-id-to-keep"]
}
```

**`get_briefing`** — Get a context briefing without starting a session.

```json
{
  "query": "caching strategy",
  "token_budget": 6000
}
```

### Versioning

**`get_memory_versions`** — Retrieve the change history of a memory.

```json
{ "memory_id": "abc123..." }
```

Returns:

```json
{
  "memory_id": "abc123...",
  "current_content": "Latest content after edits",
  "versions": [
    {
      "version": 2,
      "content": "Second version content",
      "changed_at": "2026-04-17 19:32:11"
    },
    {
      "version": 1,
      "content": "Original content",
      "changed_at": "2026-04-17 19:32:10"
    }
  ],
  "total_versions": 2
}
```

### Maintenance

**`cleanup`** — Runs four maintenance operations in one call:

- **Expire**: Remove memories past their expiry date
- **Merge**: Combine near-duplicate memories (cosine similarity ≥ 0.95)
- **Archive**: Archive old scratchpad entries
- **Promote/Decay**: Memories accessed ≥10 times get +1 importance (capped at 5). Memories not accessed for 30+ days get −1 (floored at 1). L0 memories are exempt from decay.

```json
{ "dry_run": true }
```

Returns:

```json
{
  "expired": 0,
  "merged": 0,
  "archived": 0,
  "promoted": 2,
  "decayed": 5
}
```

**`get_stats`** — Memory counts and distribution by type, layer, and importance.

```json
{ "namespace": "default" }
```

**`list_namespaces`** — List all namespaces with memory counts.

### Relations

**`add_relation`** — Create a typed relationship between two memories.

```json
{
  "source_id": "new-decision-id",
  "target_id": "old-decision-id",
  "relation_type": "supersedes"
}
```

**`get_relations`** — Get relationships for a memory.

```json
{
  "memory_id": "abc123...",
  "direction": "both"
}
```

## Configuration

All configuration is via environment variables (typically set in `.mcp.json`).

| Variable             | Required | Default                   | Description                                                            |
| -------------------- | -------- | ------------------------- | ---------------------------------------------------------------------- |
| `MEMORY_DB_PATH`     | No       | `<cwd>/claude-memory.db`  | Database path. Relative paths resolve against `process.cwd()`.         |
| `MEMORY_MODEL`       | No       | `Xenova/all-MiniLM-L6-v2` | Embedding model name.                                                  |
| `MEMORY_MODEL_CACHE` | No       | `<server>/models`         | Model cache directory. Relative paths resolve against `process.cwd()`. |
| `MEMORY_NAMESPACE`   | No       | `default`                 | Default namespace for multi-project isolation.                         |
| `MEMORY_DIMENSIONS`  | No       | `384`                     | Embedding vector dimensions.                                           |

## Multi-Namespace

One server instance can serve multiple projects. Every tool accepts an optional `namespace` parameter (defaults to `"default"`). Set `MEMORY_NAMESPACE` in the project's environment to scope memories per project.
