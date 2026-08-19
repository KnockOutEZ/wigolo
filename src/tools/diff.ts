import type {
  DiffOutput,
  DiffOutputShape,
  DiffGranularity,
  StageResult,
} from '../types.js';
import { computeDiffEnvelope } from '../cache/diff-engine.js';
import { getCachedContent, getCachedContentByHash, isExpired } from '../cache/store.js';
import { versionByHash } from '../cache/version-read.js';
import { createLogger } from '../logger.js';

const log = createLogger('cache');

/**
 * The one shape a `content_hash` miss takes.
 *
 * Explicit, never a fall-through to the current row: answering a question about
 * a past body with the page's present one is the failure §1.1.1 records, and a
 * caller diffing against it would be told the page had not changed.
 */
function hashMiss(hash: string): { ok: false; error: string; error_reason: string } {
  return {
    ok: false,
    error: 'cache_miss',
    error_reason:
      `No cached content for content_hash ${hash}. It is not the live body for any cached URL ` +
      'and no retained version carries it — retained versions are bounded and evicted ' +
      'oldest-first. Run `fetch` or `crawl` first, or pass the markdown directly.',
  };
}

const VALID_OUTPUT: DiffOutputShape[] = ['unified', 'hunks', 'summary'];
const VALID_GRANULARITY: DiffGranularity[] = ['line', 'word', 'section'];

export interface DiffInput {
  old?: { url?: string; markdown?: string; content_hash?: string };
  new?: { url?: string; markdown?: string };
  output?: DiffOutputShape;
  granularity?: DiffGranularity;
}

function resolveSide(
  side: { url?: string; markdown?: string; content_hash?: string } | undefined,
  label: 'old' | 'new',
): { ok: true; markdown: string } | { ok: false; error: string; error_reason: string } {
  // `content_hash` is a left-hand-side input only. The tool schema, the MCP
  // instructions and the public docs all scope it to `old`; accepting it on
  // `new` would make the handler more permissive than every surface that
  // documents it.
  const allowHash = label === 'old';
  const required = allowHash
    ? `${label}.markdown, ${label}.url or ${label}.content_hash is required`
    : `${label}.markdown or ${label}.url is required`;

  const hash = allowHash && typeof side?.content_hash === 'string' ? side.content_hash : undefined;

  if (!side || (side.markdown === undefined && side.url === undefined && hash === undefined)) {
    return { ok: false, error: 'invalid_input', error_reason: required };
  }
  if (typeof side.markdown === 'string') {
    return { ok: true, markdown: side.markdown };
  }
  if (typeof side.url === 'string') {
    // Pre-validate so `normalizeUrl` (called by `getCachedContent`) doesn't
    // throw `TypeError: Invalid URL` on garbage input. Returning a structured
    // envelope here keeps the surface consistent with the other input-shape
    // errors above.
    if (!URL.canParse(side.url)) {
      return {
        ok: false,
        error: 'invalid_input',
        error_reason: `${label}.url is not a valid absolute URL: ${JSON.stringify(side.url)}`,
      };
    }
    const cached = getCachedContent(side.url);
    if (!cached || isExpired(cached)) {
      return {
        ok: false,
        error: 'cache_miss',
        error_reason: `No cached content for ${side.url}. Run \`fetch\` or \`crawl\` first to populate the cache, or pass the markdown directly.`,
      };
    }
    return { ok: true, markdown: cached.markdown };
  }
  if (hash !== undefined) {
    // Content-addressed lookup: the caller holds a fingerprint from an earlier
    // `fetch` (or an export manifest) and wants that exact body back with no
    // network round-trip. Same TTL rule as the URL form — the cache only
    // serves live rows — and the same structured miss.
    const cached = getCachedContentByHash(hash);
    if (cached) {
      if (isExpired(cached)) return hashMiss(hash);
      return { ok: true, markdown: cached.markdown };
    }
    // S14-2: no live row carries this hash. `url_cache` is one row per URL under
    // INSERT OR REPLACE, so that is the ordinary state of a hash handed out
    // before the page changed — the retained version is where it now lives, and
    // reaching it is the whole point of the time axis (G-S14-2b).
    //
    // Consulted ONLY when the live lookup found nothing. An expired live row is
    // a TTL decision about that body, and the version table must not be a way to
    // read around a refusal the cache just made about the same bytes.
    const version = versionByHash(hash);
    if (version) return { ok: true, markdown: version.markdown };
    return hashMiss(hash);
  }
  return { ok: false, error: 'invalid_input', error_reason: required };
}

export async function handleDiff(
  input: DiffInput | Record<string, unknown>,
): Promise<StageResult<DiffOutput>> {
  const inp = input as DiffInput;

  const output: DiffOutputShape = inp.output ?? 'unified';
  const granularity: DiffGranularity = inp.granularity ?? 'line';

  if (!VALID_OUTPUT.includes(output)) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: `Invalid output mode '${output}'. Expected one of: ${VALID_OUTPUT.join(', ')}.`,
      stage: 'diff',
    };
  }
  if (!VALID_GRANULARITY.includes(granularity)) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: `Invalid granularity '${granularity}'. Expected one of: ${VALID_GRANULARITY.join(', ')}.`,
      stage: 'diff',
    };
  }

  // `resolveSide` reads the cache, so it belongs INSIDE the try: a SQLite-level
  // failure (locked/corrupt DB, disk full) throws synchronously, and both
  // callers of handleDiff dispatch it without a surrounding try — outside, such
  // a throw escapes the structured envelope entirely as an opaque crash.
  try {
    const oldSide = resolveSide(inp.old, 'old');
    if (!oldSide.ok) {
      return { ok: false, error: oldSide.error, error_reason: oldSide.error_reason, stage: 'diff' };
    }
    const newSide = resolveSide(inp.new, 'new');
    if (!newSide.ok) {
      return { ok: false, error: newSide.error, error_reason: newSide.error_reason, stage: 'diff' };
    }

    const data = computeDiffEnvelope({
      oldMarkdown: oldSide.markdown,
      newMarkdown: newSide.markdown,
      output,
      granularity,
    });
    return { ok: true, data };
  } catch (err) {
    log.error('diff failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: 'diff_failed',
      error_reason: err instanceof Error ? err.message : String(err),
      stage: 'diff',
    };
  }
}
