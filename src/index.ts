#!/usr/bin/env node

import { parseCommand } from './cli/index.js';
import { printHelp, printVersion, printUnknownCommand } from './cli/help.js';

async function exitCli(code: number, cleanup = true): Promise<void> {
  if (cleanup) {
    const { shutdownCli } = await import('./cli/shutdown.js');
    await shutdownCli();
  }
  // Exit naturally: set the code and let the event loop drain. Forcing
  // process.exit() here races the native ONNX runtime's thread-pool teardown
  // and aborts with `mutex lock failed: Invalid argument`; letting Node shut
  // down on its own tears the native runtime down cleanly. This relies on
  // shutdownCli() releasing every long-lived handle (search engine process,
  // browser pool, model idle timers, DB) so nothing keeps the loop alive.
  process.exitCode = code;
}

// Surface SIGABRT explicitly so the libc++ destructor noise on macOS doesn't
// look like a crash. The CLI has already completed by the time SIGABRT can
// fire — the signal handler simply forces an exit with the recorded code.
process.on('SIGABRT', () => process.exit(process.exitCode ?? 0));

/**
 * CLI entry. Extracted from module top-level to a named async function so the
 * dist entry carries no top-level `await` — a hard requirement for the
 * single-file binary, whose esbuild CJS bundle rejects top-level await.
 * Behaviour is byte-for-byte identical to the previous top-level flow: same
 * command routing, same exit-code recording via `exitCli` (natural event-loop
 * drain, never `process.exit`). Errors set a non-zero code the same way an
 * unhandled top-level rejection would have.
 */
export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--wait-for-index')) {
    process.env.WIGOLO_WAIT_FOR_INDEX = '1';
  }
  const { command, args } = parseCommand(rawArgs.filter((a) => a !== '--wait-for-index'));

  switch (command) {
    case 'warmup':
      { const { runWarmup } = await import('./cli/warmup.js');
      await runWarmup(args);
      await exitCli(0);
      }
      break;

    case 'serve':
      { const { runDaemon } = await import('./cli/daemon.js');
      runDaemon(args);
      }
      break;

    case 'health': {
      const { runHealthCheck } = await import('./cli/health.js');
      const exitCode = await runHealthCheck(args);
      await exitCli(exitCode, false);
      break;
    }

    case 'doctor': {
      const [{ runDoctorIsolated }, { getConfig }] = await Promise.all([
        import('./cli/doctor.js'),
        import('./config.js'),
      ]);
      const code = await runDoctorIsolated(getConfig().dataDir, {
        probeEngines: args.includes('--probe-engines'),
        fix: args.includes('--fix'),
        json: args.includes('--json'),
      });
      await exitCli(code);
      break;
    }

    case 'auth': {
      const { runAuth } = await import('./cli/auth.js');
      const authCode = await runAuth(args);
      await exitCli(authCode, false);
      break;
    }

    case 'shell': {
      const { runShell } = await import('./cli/shell.js');
      const shellCode = await runShell(args);
      await exitCli(shellCode);
      break;
    }

    case 'plugin': {
      const { runPluginCommand } = await import('./cli/plugin.js');
      const pluginCode = await runPluginCommand(args);
      await exitCli(pluginCode);
      break;
    }

    case 'init': {
      const { runInit } = await import('./cli/init.js');
      const initCode = await runInit(args);
      await exitCli(initCode);
      break;
    }

    case 'config':
    case 'dashboard': {
      const { runConfig } = await import('./cli/config.js');
      const configCode = await runConfig(args);
      await exitCli(configCode);
      break;
    }

    case 'uninstall': {
      const { runUninstall } = await import('./cli/uninstall.js');
      const uninstallCode = await runUninstall(args);
      await exitCli(uninstallCode);
      break;
    }

    case 'setup': {
      const { runSetupMcp } = await import('./cli/setup-mcp.js');
      const code = await runSetupMcp(args);
      await exitCli(code);
      break;
    }

    case 'skills': {
      const { runSkills } = await import('./cli/skills.js');
      const code = await runSkills(args);
      await exitCli(code);
      break;
    }

    case 'status': {
      const { runStatus } = await import('./cli/status.js');
      const code = await runStatus(args);
      await exitCli(code);
      break;
    }

    case 'tune': {
      const { runTune } = await import('./cli/tune.js');
      const code = await runTune(args);
      await exitCli(code);
      break;
    }

    case 'backfill': {
      const { runBackfill } = await import('./cli/backfill.js');
      const code = await runBackfill(args);
      await exitCli(code);
      break;
    }

    case 'verify': {
      const { runVerifyE2E } = await import('./cli/verify.js');
      const code = await runVerifyE2E(args);
      await exitCli(code);
      break;
    }

    case 'search':
    case 'fetch':
    case 'crawl':
    case 'extract':
    case 'cache':
    case 'find-similar':
    case 'find_similar':
    case 'research':
    case 'agent':
    case 'diff':
    case 'watch': {
      const { runTool } = await import('./cli/tool-run.js');
      const code = await runTool(command, args);
      await exitCli(code);
      break;
    }

    case 'help':
      printHelp();
      await exitCli(0, false);
      break;

    case 'version':
      printVersion();
      await exitCli(0, false);
      break;

    case 'unknown':
      printUnknownCommand(args[0] ?? '');
      await exitCli(1, false);
      break;

    case 'mcp': {
      const { runMcp } = await import('./cli/mcp.js');
      await runMcp();
      break;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
