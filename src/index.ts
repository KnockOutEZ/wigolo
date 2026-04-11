#!/usr/bin/env node

import { startServer } from './server.js';

const command = process.argv[2];

switch (command) {
  case 'warmup':
    console.log('warmup: not yet implemented');
    process.exit(0);
    break;

  case 'serve':
    console.log('serve: not yet implemented');
    process.exit(0);
    break;

  case 'health':
    console.log('health: ok');
    process.exit(0);
    break;

  default:
    await startServer();
    break;
}
