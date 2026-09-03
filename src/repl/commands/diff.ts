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
  'Usage: diff <url> [--old-hash=<sha256>] [--output=unified|hunks|summary]' +
  ' [--granularity=line|word|section] | diff --old="text" --new="text"' +
  ' | diff --old-hash=<sha256> --new="text"';

const OLD_CONFLICT =
  '--old-hash and --old both name the left-hand side; pass one. --old-hash reads a body ' +
  'out of the local store by its fingerprint, --old takes the text inline.';

/** `content_hash` as `fetch` and `cache` print it: sha-256, hex, unpadded. */
const CONTENT_HASH = /^[0-9a-f]{64}$/;

function errEnvelope(reason: string): DiffExecOutput {
  return { changed: false, error: reason };
}

/**
 * Accept the fingerprint in the case the user pasted it, hand it down in the
 * case the store holds. `null` when the value is not one at all — which is an
 * INPUT error, deliberately not a lookup: sent down, a typo would come back as
 * the retention-shaped miss `handleDiff` returns for a hash nothing carries,
 * and a caller could read their own typo as an eviction.
 */
function normalizeContentHash(raw: string): string | null {
  const candidate = raw.trim().toLowerCase();
  return CONTENT_HASH.test(candidate) ? candidate : null;
}

/**
 * One-shot diff. Three shapes:
 *   diff <url>                 — fetch the URL live, diff the CACHED copy
 *                                (old.url) against the freshly fetched body
 *                                (new.markdown). Populate the cache first with
 *                                `wigolo fetch <url>` / `wigolo crawl`.
 *   diff --old=… --new=…       — inline text diff, no network.
 *   diff --old-hash=… [<url>]  — K16: left side is the body carrying that
 *                                content fingerprint, resolved by `handleDiff`
 *                                against the live cache row first and a
 *                                retained version second. The right side is
 *                                still `--new` or a live fetch of `<url>`.
 */
export async function executeDiff(args: ParsedArgs, deps: ReplDeps): Promise<DiffExecOutput> {
  try {
    const url = args.positional[0];
    const oldInline = args.flags.old;
    const newInline = args.flags.new;
    const oldHashFlag = args.flags['old-hash'];

    const output = args.flags.output as DiffOutputShape | undefined;
    const granularity = args.flags.granularity as DiffGranularity | undefined;

    // --old/--new keep curated STRING semantics (wrapped below); the schema
    // `old`/`new` objects are excluded from the flag round-trip. Reject any
    // OTHER stray flag via the bridge so typos fail loudly.
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.flags)) {
      if (k === 'old' || k === 'new' || k === 'old-hash') continue;
      if (k === 'output' || k === 'granularity') continue;
      rest[k] = v;
    }
    const bridged = coerceFlags('diff', rest);
    if (bridged.errors.length > 0) {
      return errEnvelope(bridged.errors[0]);
    }

    const input: DiffInput = {};
    if (output) input.output = output;
    if (granularity) input.granularity = granularity;

    if (oldHashFlag !== undefined) {
      if (oldInline !== undefined) return errEnvelope(OLD_CONFLICT);
      const contentHash = normalizeContentHash(oldHashFlag);
      if (contentHash === null) {
        return errEnvelope(
          `--old-hash takes a 64-character hex content hash, as printed by \`fetch\` and ` +
            `\`cache --versions\`; got ${JSON.stringify(oldHashFlag)}.`,
        );
      }
      input.old = { content_hash: contentHash };

      // The right side is chosen exactly as it is without the flag: an inline
      // --new, else a live fetch of the positional URL. Nothing is defaulted —
      // a hash with no right-hand side is a half-written command, and picking
      // one for the caller would silently choose which page it is compared to.
      if (newInline !== undefined) {
        input.new = { markdown: newInline };
      } else if (url) {
        const fetched = await handleFetch({ url } satisfies FetchInput, deps.router);
        if (!fetched.ok) {
          return errEnvelope(fetched.error_reason);
        }
        input.new = { markdown: fetched.data.markdown };
      } else {
        return errEnvelope(USAGE);
      }
    } else if (oldInline !== undefined || newInline !== undefined) {
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
