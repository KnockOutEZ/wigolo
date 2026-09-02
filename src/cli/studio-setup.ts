/**
 * `wigolo studio setup` — install and pair the browser companion.
 *
 * STUB. The domain layer left core with the extraction, and the verb that replaces it is the
 * companion install path: detect the platform, fetch the signed artifact from the release host,
 * verify it, install it and hand the first run to the app for pairing. That lands next; this file
 * exists now so the route it is wired to is never dangling — a verb that answers honestly is a
 * better intermediate state than one that is absent for a commit.
 */

const USAGE = `Usage: wigolo studio setup

  setup                Install the browser companion and pair it with this machine

The browser companion is a separate application. \`setup\` is the only \`wigolo studio\`
subcommand: session and flow verbs moved into the companion itself.`;

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

export async function runStudioSetup(argv: string[]): Promise<number> {
  const sub = argv[1];
  if (!sub || sub === '--help' || sub === '-h') {
    out(USAGE);
    return sub ? 0 : 1;
  }
  if (sub !== 'setup') {
    err(`Unknown subcommand: wigolo studio ${sub}`);
    err(USAGE);
    return 1;
  }
  out('Browser companion setup arriving in the next release.');
  out('Until then, install the companion application yourself and launch it once to pair.');
  return 0;
}
