#!/usr/bin/env node

import { parseCommand } from './cli/index.js';
import { runWarmup } from './cli/warmup.js';
import { runDaemon } from './cli/daemon.js';
import { runHealthCheck } from './cli/health.js';
import { runDoctorIsolated } from './cli/doctor.js';
import { runShell } from './cli/shell.js';
import { runAuth } from './cli/auth.js';
import { runPluginCommand } from './cli/plugin.js';
import { runInit } from './cli/init.js';
import { runConfig } from './cli/config.js';
import { runMcp } from './cli/mcp.js';
import { runUninstall } from './cli/uninstall.js';
import { runSetupMcp } from './cli/setup-mcp.js';
import { runStatus } from './cli/status.js';
import { runBackfill } from './cli/backfill.js';
import { runVerifyE2E } from './cli/verify.js';
import { printHelp, printVersion, printUnknownCommand } from './cli/help.js';
import { getConfig } from './config.js';
import { shutdownCli } from './cli/shutdown.js';

async function exitCli(code: number): Promise<never> {
  await shutdownCli();
  // Defer the actual exit so native worker threads (ONNX runtime, sqlite-vec)
  // finish their teardown before libc++ destructors fire. Without this gap
  // macOS exits cleanly to the shell but prints a noisy
  // `mutex lock failed: Invalid argument` from the C++ runtime.
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.exit(code);
}

// Surface SIGABRT explicitly so the libc++ destructor noise on macOS doesn't
// look like a crash. The CLI has already completed by the time SIGABRT can
// fire — the signal handler simply forces an exit with the recorded code.
process.on('SIGABRT', () => process.exit(process.exitCode ?? 0));

const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--wait-for-index')) {
  process.env.WIGOLO_WAIT_FOR_INDEX = '1';
}
const { command, args } = parseCommand(rawArgs.filter((a) => a !== '--wait-for-index'));

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
    const code = await runDoctorIsolated(getConfig().dataDir, {
      probeEngines: args.includes('--probe-engines'),
    });
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
    await exitCli(0);
    break;

  case 'plugin':
    runPluginCommand(args);
    await exitCli(0);
    break;

  case 'init': {
    const initCode = await runInit(args);
    await exitCli(initCode);
    break;
  }

  case 'config':
  case 'dashboard': {
    const configCode = await runConfig(args);
    await exitCli(configCode);
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

  case 'verify': {
    const code = await runVerifyE2E(args);
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
    await runMcp();
    break;
  }
}
