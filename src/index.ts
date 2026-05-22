#!/usr/bin/env node

import { parseCommand } from './cli/index.js';
import { runWarmup } from './cli/warmup.js';
import { runDaemon } from './cli/daemon.js';
import { runHealthCheck } from './cli/health.js';
import { runDoctor } from './cli/doctor.js';
import { runShell } from './cli/shell.js';
import { runAuth } from './cli/auth.js';
import { runPluginCommand } from './cli/plugin.js';
import { runInit } from './cli/init.js';
import { runUninstall } from './cli/uninstall.js';
import { runSetupMcp } from './cli/setup-mcp.js';
import { runStatus } from './cli/status.js';
import { runBackfill } from './cli/backfill.js';
import { printHelp, printVersion, printUnknownCommand } from './cli/help.js';
import { getConfig } from './config.js';
import { startServer } from './server.js';
import { shutdownCli } from './cli/shutdown.js';

async function exitCli(code: number): Promise<never> {
  await shutdownCli();
  process.exit(code);
}

const { command, args } = parseCommand(process.argv.slice(2));

switch (command) {
  case 'warmup':
    await runWarmup(args);
    await exitCli(0);
    break;

  case 'serve':
    runDaemon(args);
    break;

  case 'health': {
    const exitCode = await runHealthCheck();
    await exitCli(exitCode);
    break;
  }

  case 'doctor': {
    const code = await runDoctor(getConfig().dataDir);
    await exitCli(code);
    break;
  }

  case 'auth': {
    const authCode = await runAuth(args);
    await exitCli(authCode);
    break;
  }

  case 'shell':
    await runShell(args);
    break;

  case 'plugin':
    runPluginCommand(args);
    break;

  case 'init': {
    const initCode = await runInit(args);
    await exitCli(initCode);
    break;
  }

  case 'uninstall': {
    const uninstallCode = await runUninstall(args);
    await exitCli(uninstallCode);
    break;
  }

  case 'setup': {
    const code = await runSetupMcp(args);
    await exitCli(code);
    break;
  }

  case 'status': {
    const code = await runStatus(args);
    await exitCli(code);
    break;
  }

  case 'backfill': {
    const code = await runBackfill(args);
    await exitCli(code);
    break;
  }

  case 'help':
    printHelp();
    await exitCli(0);
    break;

  case 'version':
    printVersion();
    await exitCli(0);
    break;

  case 'unknown':
    printUnknownCommand(args[0] ?? '');
    await exitCli(1);
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
