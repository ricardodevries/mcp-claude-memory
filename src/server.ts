import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { MemoryServerConfig } from './config.js';
import { MemoryService } from './services/memory.js';
import { SearchService } from './services/search.js';
import { SessionService } from './services/session.js';
import { CleanupService } from './services/cleanup.js';
import { MEMORY_TYPES, CONTEXT_LAYERS, RELATION_TYPES } from './types.js';

export function createServer(db: Database.Database, config: MemoryServerConfig): McpServer {
  const server = new McpServer({
    name: 'mcp-claude-memory',
    version: '0.1.0',
    websiteUrl: 'https://github.com/ricardodevries/mcp-claude-memory',
  });

  const memoryService = new MemoryService(db, config);
  const searchService = new SearchService(db, config);
  const sessionService = new SessionService(db, config);
  const cleanupService = new CleanupService(db, config);

  server.registerTool(
    'add_memories',
    {
      description:
        'Add one or more memories to the store. Returns IDs of created memories and any deduplicated (already-existing) matches.',
      inputSchema: {
        memories: z
          .array(
            z.object({
              content: z.string().describe('The memory content text'),
              memory_type: z.enum(MEMORY_TYPES).optional().describe('Type classification. Default: observation'),
              context_layer: z
                .number()
                .int()
                .min(0)
                .max(3)
                .optional()
                .describe(
                  'Context layer (0=permanent rules, 1=session-start, 2=task-specific, 3=ephemeral). Default: 2',
                ),
              importance: z.number().int().min(1).max(5).optional().describe('Importance score 1-5. Default: 3'),
              source: z.string().optional().describe('Origin identifier (e.g. "user", "agent:planner", "system")'),
              namespace: z.string().optional().describe('Namespace for multi-project isolation. Default: "default"'),
              tags: z.array(z.string()).optional().describe('Tags for filtering'),
              metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata'),
              expires_at: z.string().optional().describe('ISO 8601 expiration datetime'),
            }),
          )
          .describe('Array of memories to add'),
      },
    },
    async ({ memories }) => {
      const added: string[] = [];
      const deduplicated: string[] = [];

      for (const mem of memories) {
        const result = await memoryService.addMemory({
          ...mem,
          context_layer: mem.context_layer as 0 | 1 | 2 | 3 | undefined,
        });
        if (result.deduplicated) {
          deduplicated.push(result.existing_id!);
        } else {
          added.push(result.id);
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ added, deduplicated }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_memory',
    {
      description: 'Retrieve a single memory by its ID.',
      inputSchema: {
        id: z.string().describe('Memory ID'),
      },
    },
    async ({ id }) => {
      const memory = memoryService.getMemory(id);
      return {
        content: [
          {
            type: 'text' as const,
            text: memory ? JSON.stringify(memory, null, 2) : 'Memory not found.',
          },
        ],
      };
    },
  );

  server.registerTool(
    'update_memory',
    {
      description: 'Update an existing memory. Re-embeds if content changes.',
      inputSchema: {
        id: z.string().describe('Memory ID to update'),
        content: z.string().optional().describe('New content (triggers re-embedding)'),
        memory_type: z.enum(MEMORY_TYPES).optional(),
        context_layer: z.number().int().min(0).max(3).optional(),
        importance: z.number().int().min(1).max(5).optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.unknown()).optional(),
        expires_at: z.string().nullable().optional().describe('Set null to remove expiration'),
      },
    },
    async ({ id, ...updates }) => {
      const memory = await memoryService.updateMemory(id, {
        ...updates,
        context_layer: updates.context_layer as 0 | 1 | 2 | 3 | undefined,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: memory ? JSON.stringify(memory, null, 2) : 'Memory not found.',
          },
        ],
      };
    },
  );

  server.registerTool(
    'delete_memories',
    {
      description: 'Delete (archive) or permanently remove memories.',
      inputSchema: {
        ids: z.array(z.string()).describe('Memory IDs to delete'),
        hard: z.boolean().optional().describe('If true, permanently delete. Default: false (soft-delete/archive)'),
      },
    },
    async ({ ids, hard }) => {
      const count = memoryService.deleteMemories(ids, hard ?? false);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ deleted: count }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'search_memories',
    {
      description:
        'Search memories using hybrid semantic + lexical search. Returns ranked results with relevance scores.',
      inputSchema: {
        query: z.string().describe('Natural language search query'),
        namespace: z.string().optional(),
        context_layer: z.array(z.number().int().min(0).max(3)).optional().describe('Filter by context layers'),
        memory_type: z.array(z.enum(MEMORY_TYPES)).optional().describe('Filter by memory types'),
        importance_min: z.number().int().min(1).max(5).optional().describe('Minimum importance score'),
        tags: z.array(z.string()).optional().describe('Filter by tags (AND logic)'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results. Default: 10'),
        threshold: z.number().min(0).max(1).optional().describe('Minimum relevance score. Default: 0.0'),
        search_mode: z.enum(['hybrid', 'semantic', 'lexical']).optional().describe('Search strategy. Default: hybrid'),
      },
    },
    async (params) => {
      const results = await searchService.search(params);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ results, count: results.length }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_context_layers',
    {
      description: 'Retrieve all memories organized by context layer (L0-L3), respecting token budgets per layer.',
      inputSchema: {
        namespace: z.string().optional(),
        layers: z.array(z.number().int().min(0).max(3)).optional().describe('Which layers to include. Default: all'),
        token_budget: z
          .object({
            L0: z.number().optional(),
            L1: z.number().optional(),
            L2: z.number().optional(),
            L3: z.number().optional(),
          })
          .optional()
          .describe('Override default token budgets per layer'),
        query: z.string().optional().describe('If provided, L2 results are query-relevant'),
      },
    },
    async (params) => {
      const result = sessionService.getContextLayers(params);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'start_session',
    {
      description: 'Begin a new memory session. Optionally returns a session briefing.',
      inputSchema: {
        namespace: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        include_briefing: z.boolean().optional().describe('Include a session-start briefing. Default: true'),
        query: z.string().optional().describe('Focus area for briefing relevance'),
      },
    },
    async ({ include_briefing, query, ...opts }) => {
      const sessionId = sessionService.startSession(opts);
      let briefing = null;
      if (include_briefing !== false) {
        briefing = await sessionService.getBriefing({
          namespace: opts.namespace,
          query,
        });
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ session_id: sessionId, briefing }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'end_session',
    {
      description: 'Close an active session. Optionally promote scratchpad (L3) memories to L2.',
      inputSchema: {
        session_id: z.string().describe('Session ID to close'),
        summary: z.string().optional().describe('Session summary text'),
        promote_scratchpad: z.array(z.string()).optional().describe('L3 memory IDs to promote to L2 before cleanup'),
      },
    },
    async (params) => {
      sessionService.endSession(params.session_id, {
        summary: params.summary,
        promote_scratchpad: params.promote_scratchpad,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'closed',
              session_id: params.session_id,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_briefing',
    {
      description:
        'Generate a session-start briefing with rules, state, and relevant context without creating a session.',
      inputSchema: {
        namespace: z.string().optional(),
        query: z.string().optional().describe('Focus area for retrieving relevant L2 memories'),
        token_budget: z.number().optional().describe('Max tokens for the entire briefing. Default: 6000'),
      },
    },
    async (params) => {
      const briefing = await sessionService.getBriefing(params);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(briefing, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'cleanup',
    {
      description: 'Remove expired memories, merge near-duplicates, and archive old scratchpad entries.',
      inputSchema: {
        namespace: z.string().optional(),
        dry_run: z
          .boolean()
          .optional()
          .describe('If true, report what would be cleaned without making changes. Default: false'),
      },
    },
    async (params) => {
      const result = cleanupService.cleanup(params);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_stats',
    {
      description: 'Get database statistics: memory counts by layer and type, database size.',
      inputSchema: {
        namespace: z.string().optional(),
      },
    },
    async ({ namespace }) => {
      const stats = memoryService.getStats(namespace);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'list_namespaces',
    {
      description: 'List all namespaces in the database with their memory counts.',
    },
    async () => {
      const namespaces = memoryService.listNamespaces();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ namespaces }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'add_relation',
    {
      description: 'Create a typed relation between two memories.',
      inputSchema: {
        source_id: z.string().describe('Source memory ID'),
        target_id: z.string().describe('Target memory ID'),
        relation_type: z.enum(RELATION_TYPES).describe('Relation type'),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    async (params) => {
      const id = memoryService.addRelation(params);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ id }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_memory_versions',
    {
      description:
        'Retrieve the version history of a memory. Each entry is a previous content snapshot taken before an update.',
      inputSchema: {
        memory_id: z.string().describe('Memory ID'),
      },
    },
    async ({ memory_id }) => {
      const current = memoryService.getMemory(memory_id);
      const versions = memoryService.getMemoryVersions(memory_id);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                memory_id,
                current_content: current?.content ?? null,
                versions,
                total_versions: versions.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_relations',
    {
      description: 'Get relations connected to a memory.',
      inputSchema: {
        memory_id: z.string().describe('Memory ID'),
        direction: z.enum(['outgoing', 'incoming', 'both']).optional().describe('Relation direction. Default: both'),
        relation_type: z.string().optional().describe('Filter by relation type'),
      },
    },
    async ({ memory_id, direction, relation_type }) => {
      const relations = memoryService.getRelations(memory_id, direction ?? 'both', relation_type);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ relations, count: relations.length }, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
