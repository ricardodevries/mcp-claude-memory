#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createStore } from './db/store.js';
import { initEmbedder } from './services/embedder.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  process.stderr.write(`Initializing with db: ${config.dbPath}\n`);
  process.stderr.write(`Embedding model: ${config.embeddingModel}\n`);

  const db = createStore(config);

  process.stderr.write('Loading embedding model (first run may download ~27MB)...\n');
  await initEmbedder(config);
  process.stderr.write('Embedding model loaded.\n');

  const server = createServer(db, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('MCP server running on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
