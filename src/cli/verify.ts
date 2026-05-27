/**
 * SP6 — standalone `wigolo verify` command.
 *
 * Runs the end-to-end capability smoke check and prints a machine-readable
 * result. Exit code 0 when all capabilities pass (skipped counts as pass);
 * exit code 1 on any hard failure.
 *
 * Flags:
 *   --plain / -y / --non-interactive   force non-interactive plain output
 *   --help / -h                        print usage
 */

const VERIFY_USAGE = [
  'Usage: wigolo verify [options]',
  '',
  'Options:',
  '  --plain, --non-interactive, -y   Force plain text output (no TUI)',
  '  --help, -h                       Show this message',
  '',
  'Exit code 0 when all capabilities pass or skip.',
  'Exit code 1 when any capability fails.',
  '',
].join('\n');

interface VerifyFlags {
  plain: boolean;
  help: boolean;
}

export function parseVerifyFlags(args: string[]): VerifyFlags {
  const flags: VerifyFlags = { plain: false, help: false };
  for (const arg of args) {
    if (arg === '--plain' || arg === '-y' || arg === '--non-interactive') {
      flags.plain = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
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

  for (const line of formatVerifyResultPlain(result)) {
    process.stderr.write(`${line}\n`);
  }

  return result.allPassed ? 0 : 1;
}
