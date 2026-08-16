#!/usr/bin/env node

import { parseCommand } from './cli/index.js';
import { runWarmup } from './cli/warmup.js';
import { runDaemon } from './cli/daemon.js';
import { runStudio } from './cli/studio.js';
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
import { runSkills } from './cli/skills.js';
import { runStatus } from './cli/status.js';
import { runTune } from './cli/tune.js';
import { runBackfill } from './cli/backfill.js';
import { runExport } from './cli/export.js';
import { runVerifyE2E } from './cli/verify.js';
import { printHelp, printVersion, printUnknownCommand } from './cli/help.js';
import { runTool } from './cli/tool-run.js';
import { getConfig } from './config.js';
import { shutdownCli } from './cli/shutdown.js';

async function exitCli(code: number): Promise<void> {
  await shutdownCli();
  // Exit naturally: set the code and let the event loop drain. Do NOT call
  // process.exit() here — the exit path is the one variable measured to decide
  // whether the `mutex lock failed: Invalid argument` SIGABRT fires. Plain Node
  // on macOS/arm64, 10 cells x 10 reps, 0 invalid: a process that has created
  // and run an inference session in the native runtime aborts 10/10 on
  // process.exit(), and exits clean 10/10 when it drains instead — same
  // process, same work, only the exit path differs.
  //
  // That session is a measured PRECONDITION, not a cause. Loading the native
  // runtime without running anything through it never reproduces the abort
  // (0/10) — which is why an earlier investigation that probed only a bare
  // module load found every arm clean and recorded the mechanism as
  // unreproducible. Both records are correct about what each actually
  // measured; they differ in whether a session was ever run. WHY the exit path
  // decides it remains OPEN and is deliberately not asserted here: an earlier
  // version of this comment stated a thread-pool teardown race as fact on no
  // measurement, and a named-but-wrong cause has already cost this codebase two
  // investigations.
  //
  // Two negatives are settled and should not be re-tested: releasing the
  // session before exiting still aborts 10/10, so this is not a
  // teardown-ordering problem; and a process that touches only the DB never
  // aborts, closed or not (10/10 clean), so the cache layer is not involved in
  // either direction.
  //
  // Draining relies on shutdownCli() having released every long-lived handle
  // (search engine process, browser pool, model idle timers, DB) — if anything
  // still holds the loop open the CLI hangs instead of exiting.
  process.exitCode = code;
}

// Backstop for the abort described above, in case it reaches us anyway: it is
// cosmetic-but-loud rather than a real failure, since the CLI has already
// completed by the time SIGABRT can fire, so the handler simply forces an exit
// with the recorded code instead of letting it look like a crash. What
// produces the signal is not attributed here — see `exitCli`.
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
      await runWarmup(args);
      await exitCli(0);
      break;

    case 'serve':
      runDaemon(args);
      break;

    // Internal/unadvertised (Phase 0): boots the Studio session host. Intentionally
    // absent from `help` until the full UX lands so it isn't mistaken for complete.
    case 'studio':
      runStudio(args);
      break;

    case 'health': {
      const exitCode = await runHealthCheck(args);
      await exitCli(exitCode);
      break;
    }

    case 'doctor': {
      const code = await runDoctorIsolated(getConfig().dataDir, {
        probeEngines: args.includes('--probe-engines'),
        fix: args.includes('--fix'),
        json: args.includes('--json'),
      });
      await exitCli(code);
      break;
    }

    case 'auth': {
      const authCode = await runAuth(args);
      await exitCli(authCode);
      break;
    }

    case 'shell': {
      const shellCode = await runShell(args);
      await exitCli(shellCode);
      break;
    }

    case 'plugin': {
      const pluginCode = await runPluginCommand(args);
      await exitCli(pluginCode);
      break;
    }

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

    case 'skills': {
      const code = await runSkills(args);
      await exitCli(code);
      break;
    }

    case 'status': {
      const code = await runStatus(args);
      await exitCli(code);
      break;
    }

    case 'tune': {
      const code = await runTune(args);
      await exitCli(code);
      break;
    }

    case 'backfill': {
      const code = await runBackfill(args);
      await exitCli(code);
      break;
    }

    case 'export': {
      const code = await runExport(args);
      await exitCli(code);
      break;
    }

    case 'verify': {
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
      const code = await runTool(command, args);
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
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
