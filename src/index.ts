#!/usr/bin/env node

import { parseCommand } from './cli/index.js';
import { runWarmup } from './cli/warmup.js';
import { runDaemon } from './cli/daemon.js';
import { runHealthCheck } from './cli/health.js';
import { startServer } from './server.js';

const { command, args } = parseCommand(process.argv.slice(2));

switch (command) {
  case 'warmup':
    await runWarmup();
    break;

  case 'serve':
    runDaemon(args);
    break;

  case 'health':
    runHealthCheck();
    break;

  case 'mcp':
    await startServer();
    break;
}
