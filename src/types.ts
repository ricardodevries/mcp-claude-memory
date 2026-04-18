export const MEMORY_TYPES = [
  'observation',
  'decision',
  'rule',
  'preference',
  'issue',
  'research',
  'session_summary',
  'scratchpad',
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export const CONTEXT_LAYERS = [0, 1, 2, 3] as const;
export type ContextLayer = (typeof CONTEXT_LAYERS)[number];

export const RELATION_TYPES = ['supersedes', 'related_to', 'contradicts', 'depends_on'] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export interface Memory {
  id: string;
  content: string;
  memory_type: MemoryType;
  context_layer: ContextLayer;
  importance: number;
  source: string | null;
  namespace: string;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  accessed_at: string;
  access_count: number;
  expires_at: string | null;
  superseded_by: string | null;
  is_archived: number;
}

export interface MemoryRow {
  id: string;
  content: string;
  memory_type: string;
  context_layer: number;
  importance: number;
  source: string | null;
  namespace: string;
  tags: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  accessed_at: string;
  access_count: number;
  expires_at: string | null;
  superseded_by: string | null;
  is_archived: number;
}

export interface Relation {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: RelationType;
  namespace: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface Session {
  id: string;
  namespace: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
}

export interface SessionSummary {
  id: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

export interface SearchResult extends Memory {
  relevance: number;
}

export interface LayerBudget {
  memories: Memory[];
  token_count: number;
  budget: number;
}

export interface ContextLayersResult {
  layers: {
    L0: LayerBudget;
    L1: LayerBudget;
    L2: LayerBudget;
    L3: LayerBudget;
  };
  total_tokens: number;
  total_budget: number;
}

export interface Briefing {
  rules: Memory[];
  state: Memory[];
  relevant: Memory[];
  recent_sessions: SessionSummary[];
  token_count: number;
}

export interface CleanupResult {
  expired: number;
  merged: number;
  archived: number;
  promoted: number;
  decayed: number;
}

export interface Stats {
  total_memories: number;
  by_layer: Record<string, number>;
  by_type: Record<string, number>;
  db_size_bytes: number;
}

export function rowToMemory(row: MemoryRow): Memory {
  return {
    ...row,
    memory_type: row.memory_type as MemoryType,
    context_layer: row.context_layer as ContextLayer,
    tags: row.tags ? JSON.parse(row.tags) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.15);
}
