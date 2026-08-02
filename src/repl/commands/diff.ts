import type {
  DiffOutput,
  DiffOutputShape,
  DiffGranularity,
  FetchInput,
} from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleDiff, type DiffInput } from '../../tools/diff.js';
import { handleFetch } from '../../tools/fetch.js';
import { coerceFlags } from '../../cli/flag-bridge.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

export type DiffExecOutput = DiffOutput & { error?: string };

const USAGE =
  'Usage: diff <url> [--output=unified|hunks|summary] [--granularity=line|word|section]' +
  ' | diff --old="text" --new="text"';

function errEnvelope(reason: string): DiffExecOutput {
  return { changed: false, error: reason };
}

/**
 * One-shot diff. Two shapes:
 *   diff <url>                 — fetch the URL live, diff the CACHED copy
 *                                (old.url) against the freshly fetched body
 *                                (new.markdown). Populate the cache first with
 *                                `wigolo fetch <url>` / `wigolo crawl`.
 *   diff --old=… --new=…       — inline text diff, no network.
 */
export async function executeDiff(args: ParsedArgs, deps: ReplDeps): Promise<DiffExecOutput> {
  try {
    const url = args.positional[0];
    const oldInline = args.flags.old;
    const newInline = args.flags.new;

    const output = args.flags.output as DiffOutputShape | undefined;
    const granularity = args.flags.granularity as DiffGranularity | undefined;

    // --old/--new keep curated STRING semantics (wrapped below); the schema
    // `old`/`new` objects are excluded from the flag round-trip. Reject any
    // OTHER stray flag via the bridge so typos fail loudly.
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.flags)) {
      if (k === 'old' || k === 'new' || k === 'output' || k === 'granularity') continue;
      rest[k] = v;
    }
    const bridged = coerceFlags('diff', rest);
    if (bridged.errors.length > 0) {
      return errEnvelope(bridged.errors[0]);
    }

    const input: DiffInput = {};
    if (output) input.output = output;
    if (granularity) input.granularity = granularity;

    if (oldInline !== undefined || newInline !== undefined) {
      // Inline mode — pure text diff, no fetch.
      input.old = { markdown: oldInline ?? '' };
      input.new = { markdown: newInline ?? '' };
    } else if (url) {
      // Live mode — cached copy vs freshly fetched body.
      const fetchInput: FetchInput = { url };
      const fetched = await handleFetch(fetchInput, deps.router);
      if (!fetched.ok) {
        return errEnvelope(fetched.error_reason);
      }
      input.old = { url };
      input.new = { markdown: fetched.data.markdown };
    } else {
      return errEnvelope(USAGE);
    }

    log.debug('executing diff command', { url, flags: args.flags });
    const r = await handleDiff(input);
    if (!r.ok) {
      return errEnvelope(r.error_reason);
    }
    return r.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('diff command failed', { error: msg });
    return errEnvelope(msg);
  }
}
