/**
 * SP6 — standalone `wigolo verify` command.
 *
 * Runs the end-to-end capability smoke check and prints a machine-readable
 * result. Exit code 0 when all capabilities pass (skipped counts as pass);
 * exit code 1 on any hard failure.
 *
 * Flags:
 *   --plain / -y   force plain (non-TUI) output
 *   --help / -h    print usage
 */

const VERIFY_USAGE = [
  'Usage: wigolo verify [options]',
  '',
  'Options:',
  '  --plain, -y                      Force plain text output (no TUI)',
  '  --json                           Emit a machine-readable result on stdout',
  '  --help, -h                       Show this message',
  '',
  'Exit code 0 when all capabilities pass or skip.',
  'Exit code 1 when any capability fails.',
  '',
].join('\n');

interface VerifyFlags {
  plain: boolean;
  help: boolean;
  json: boolean;
}

export function parseVerifyFlags(args: string[]): VerifyFlags {
  const flags: VerifyFlags = { plain: false, help: false, json: false };
  for (const arg of args) {
    if (arg === '--plain' || arg === '-y' || arg === '--non-interactive') {
      flags.plain = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--json') {
      flags.json = true;
    }
  }
  return flags;
}

export async function runVerifyE2E(args: string[]): Promise<number> {
  const flags = parseVerifyFlags(args);

  if (flags.help) {
    process.stderr.write(VERIFY_USAGE);
    return 0;
  }

  const { buildDefaultDeps, verifyEndToEnd, formatVerifyResultPlain } = await import(
    './tui/actions/verify-e2e.js'
  );

  const deps = await buildDefaultDeps();
  const result = await verifyEndToEnd(deps);

  if (flags.json) {
    // Machine shape on stdout; the pretty lines stay on stderr. `status` is
    // exit-code-meaningful: allPassed → 'ok' (exit 0), else 'failed' (exit 1).
    process.stdout.write(`${JSON.stringify({ status: result.allPassed ? 'ok' : 'failed', ...result })}\n`);
    return result.allPassed ? 0 : 1;
  }

  for (const line of formatVerifyResultPlain(result)) {
    process.stderr.write(`${line}\n`);
  }

  return result.allPassed ? 0 : 1;
}
