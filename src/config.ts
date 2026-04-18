import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..');

export interface TokenBudgets {
  L0: number;
  L1: number;
  L2: number;
  L3: number;
}

export interface DedupConfig {
  writeThreshold: number;
  mergeThreshold: number;
  relatedThreshold: number;
}

export interface MemoryServerConfig {
  dbPath: string;
  embeddingModel: string;
  embeddingDimensions: number;
  modelCacheDir: string;
  tokenBudgets: TokenBudgets;
  dedup: DedupConfig;
  namespace: string;
}

function resolvePath(p: string): string {
  if (isAbsolute(p)) return p;
  return resolve(process.cwd(), p);
}

export function loadConfig(): MemoryServerConfig {
  return {
    dbPath: process.env.MEMORY_DB_PATH
      ? resolvePath(process.env.MEMORY_DB_PATH)
      : resolve(process.cwd(), 'claude-memory.db'),
    embeddingModel: process.env.MEMORY_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
    embeddingDimensions: process.env.MEMORY_DIMENSIONS ? parseInt(process.env.MEMORY_DIMENSIONS, 10) : 384,
    modelCacheDir: process.env.MEMORY_MODEL_CACHE
      ? resolvePath(process.env.MEMORY_MODEL_CACHE)
      : resolve(SERVER_ROOT, 'models'),
    tokenBudgets: { L0: 2000, L1: 4000, L2: 6000, L3: 2000 },
    dedup: { writeThreshold: 0.92, mergeThreshold: 0.95, relatedThreshold: 0.8 },
    namespace: process.env.MEMORY_NAMESPACE ?? 'default',
  };
}
