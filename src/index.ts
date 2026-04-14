#!/usr/bin/env node

import { parseCommand } from './cli/index.js';
import { runWarmup } from './cli/warmup.js';
import { runDaemon } from './cli/daemon.js';
import { runHealthCheck } from './cli/health.js';
import { runDoctor } from './cli/doctor.js';
import { runShell } from './cli/shell.js';
import { runAuth } from './cli/auth.js';
import { runPluginCommand } from './cli/plugin.js';
import { getConfig } from './config.js';
import { startServer } from './server.js';

const { command, args } = parseCommand(process.argv.slice(2));

switch (command) {
  case 'warmup':
    await runWarmup(args);
    break;

  case 'serve':
    runDaemon(args);
    break;

  case 'health': {
    const exitCode = await runHealthCheck();
    process.exit(exitCode);
    break;
  }

  case 'doctor': {
    const code = await runDoctor(getConfig().dataDir);
    process.exit(code);
    break;
  }

  case 'auth': {
    const authCode = await runAuth(args);
    process.exit(authCode);
    break;
  }

  case 'shell':
    await runShell(args);
    break;

  case 'plugin':
    runPluginCommand(args);
    break;

  case 'mcp': {
    const config = getConfig();

    try {
      const { tryConnectDaemon } = await import('./daemon/proxy.js');
      const report = await tryConnectDaemon(config.daemonPort, config.daemonHost);
      if (report) {
        process.stderr.write(
          `[wigolo] Daemon detected at ${config.daemonHost}:${config.daemonPort} ` +
          `(status: ${report.status}). Full proxy deferred to v2.1; starting local server.\n`,
        );
      }
    } catch {
      // Daemon proxy module may not be available -- fall through to local server
    }

    await startServer();
    break;
  }
}
