import { getConfig } from '../config.js';
import { exportCorpus } from '../cache/export-corpus.js';

const HELP = `wigolo export — write the local page cache out as dated Markdown plus a manifest

Usage:
  wigolo export [--out DIR] [--url-pattern GLOB] [--since DATE] [--dry-run] [--json]

Writes one Markdown file per cached page under DIR/pages/<fetch-date>/, each opening with a
front-matter block carrying its source URL, fetch time, content hash and HTTP status, plus a
DIR/manifest.json index and a DIR/README.md explaining the layout. Plain files, no
proprietary format — the corpus stays readable with wigolo uninstalled.

Options:
  --out DIR           Output directory (default ./wigolo-export)
  --url-pattern GLOB  Only pages whose URL matches this glob, e.g. 'https://docs.example.com/*'
  --since DATE        Only pages fetched after this date, e.g. 2026-01-01
  --dry-run           Report what would be written; create nothing
  --json              Emit a single machine-readable JSON summary on stdout
  -h, --help          Print this help

Exit code is 1 when any cached row is refused as an anomaly.
`;

const VALUE_FLAGS = new Set(['--out', '--url-pattern', '--since']);
const BOOLEAN_FLAGS = new Set(['--dry-run', '--json']);

interface ParsedArgs {
  out: string;
  urlPattern?: string;
  since?: string;
  dryRun: boolean;
  json: boolean;
  error?: string;
}

/**
 * Accepts both `--flag value` and `--flag=value`. An unrecognised flag is an ERROR, not an
 * ignored token: silently exporting with a different scope than the one asked for would make
 * the artifact misleading, which is the one thing this command cannot afford.
 */
function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { out: 'wigolo-export', dryRun: false, json: false };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq > 0 ? arg.slice(eq + 1) : undefined;

    if (BOOLEAN_FLAGS.has(name)) {
      if (name === '--dry-run') parsed.dryRun = true;
      else parsed.json = true;
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue ?? args[++i];
      if (value === undefined || value.length === 0) {
        parsed.error = `${name} requires a value`;
        return parsed;
      }
      if (name === '--out') parsed.out = value;
      else if (name === '--url-pattern') parsed.urlPattern = value;
      else parsed.since = value;
      continue;
    }

    parsed.error = `unknown option '${arg}'`;
    return parsed;
  }

  return parsed;
}

export async function runExport(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  const opts = parseArgs(args);
  if (opts.error) {
    process.stderr.write(`wigolo export: ${opts.error}\n\n${HELP}`);
    return 1;
  }

  // Progress and summary go to stderr so --json keeps stdout to a single document.
  process.stderr.write(`[wigolo export] reading cache${opts.dryRun ? ' (dry-run)' : ''}…\n`);

  const result = await exportCorpus({
    dataDir: getConfig().dataDir,
    outDir: opts.out,
    urlPattern: opts.urlPattern,
    since: opts.since,
    dryRun: opts.dryRun,
    onProgress: (done) => {
      if (done % 100 === 0) process.stderr.write(`  ${done} pages\n`);
    },
  });

  // An anomaly means a cached row was refused because it carried something that should never
  // have been persisted. Exiting non-zero keeps a scripted export from passing over a store bug.
  const exitCode = result.anomalies > 0 ? 1 : 0;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      status: exitCode === 0 ? 'ok' : 'error',
      out_dir: opts.out,
      scanned: result.scanned,
      exported: result.exported,
      skipped: result.skipped.length,
      anomalies: result.anomalies,
      dry_run: result.dryRun,
    })}\n`);
    return exitCode;
  }

  process.stderr.write(
    `[wigolo export] done: scanned=${result.scanned} exported=${result.exported} ` +
      `skipped=${result.skipped.length} anomalies=${result.anomalies} out=${opts.out}` +
      `${result.dryRun ? ' (dry-run — nothing written)' : ''}\n`,
  );
  if (result.anomalies > 0) {
    process.stderr.write(
      '[wigolo export] some cached rows carried a containment marker and were refused — ' +
        'see the manifest\'s skipped list; this is a bug worth reporting.\n',
    );
  }
  return exitCode;
}
