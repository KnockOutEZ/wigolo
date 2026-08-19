import { getDatabase } from './db.js';
import { normalizeUrl } from './store.js';
import { applyCacheOutputBudget } from './output-budget.js';
import type {
  CacheOutput,
  CacheResultItem,
  CacheVersionListEntry,
  CacheVersionResult,
} from '../types.js';

/**
 * S14-2 — reading the time axis S14-1 records.
 *
 * Two reads, one table. `versionAt` reconstructs the body a URL served at a
 * moment; `listVersionMeta` indexes what is retained for it. Both are scoped to
 * a single URL by design: this surface answers "what did THIS page look like",
 * never "what has this machine seen".
 *
 * The exposure class is unchanged from `cache` today (A155-A) — page bodies from
 * the local store, already readable by URL. What is new is the time coordinate,
 * not the kind of content.
 */

interface VersionRow {
  normalized_url: string;
  content_hash: string;
  markdown: string;
  title: string | null;
  http_status: number | null;
  fetched_at: string;
  byte_len: number;
}

export interface RetainedVersion {
  normalizedUrl: string;
  contentHash: string;
  markdown: string;
  title: string | null;
  httpStatus: number | null;
  /** Zone-less UTC "YYYY-MM-DD HH:MM:SS" — when this body was LAST observed. */
  observedAt: string;
  byteLen: number;
}

/**
 * A date-TIME carrying NO zone designator, in either separator.
 *
 * Both separators, deliberately. The space form is what `fetched_at` is stored
 * in; the `T` form is plain ISO 8601 and is what this tool's own schema invites
 * a caller to send. ECMAScript parses the first as local by its legacy fallback
 * and the second as local by specification, so the two shapes exhibit the SAME
 * hazard and closing one is not closing it.
 *
 * Seconds and fractions are optional because "2026-08-18T13:00" is equally
 * offset-less and equally shifted.
 */
const ZONELESS_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** `YYYY-MM-DD`. ECMAScript reads the date-only ISO form as UTC already. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The same date-time carrying an explicit `Z` or numeric offset. Unambiguous by
 * construction, so `Date.parse` resolves it correctly and is left to.
 */
const ZONED_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

const SELECT_COLUMNS =
  'normalized_url, content_hash, markdown, title, http_status, fetched_at, byte_len';

/** Default and ceiling on entries one version list returns. */
export const DEFAULT_VERSION_LIST_LIMIT = 20;
export const MAX_VERSION_LIST_LIMIT = 200;

/**
 * What a caller must not read into a version list.
 *
 * Every clause is a property of the store as shipped, not a disclaimer. The byte
 * bound sweeps the whole table oldest-first across URLs (K31), so a quiet page's
 * only version can be evicted by a churning one — "everything this page served"
 * is not something this surface can promise. And a body that returns to an
 * earlier form is re-timed onto the row it already has rather than added, so the
 * entry count is a count of distinct retained bodies, never of changes.
 */
export const VERSION_LIST_NOTE =
  'Retained versions only, newest first. Storage bounds evict oldest-first across every URL, ' +
  'so an entry listed here can be gone later and gaps between entries do not mean the page ' +
  'held still. A body that returns to an earlier form is re-timed onto its existing entry, so ' +
  'this is a count of distinct retained bodies, not a change count.';

function toRetained(row: VersionRow): RetainedVersion {
  return {
    normalizedUrl: row.normalized_url,
    contentHash: row.content_hash,
    markdown: row.markdown,
    title: row.title,
    httpStatus: row.http_status,
    observedAt: row.fetched_at,
    byteLen: row.byte_len,
  };
}

/**
 * A caller's `at` in the zone-less UTC shape `fetched_at` is stored in, or null
 * when it cannot be parsed.
 *
 * A value carrying NO zone designator is read as UTC, in BOTH separators.
 * JavaScript reads an offset-less date-time as LOCAL — the space form by its
 * legacy fallback parser, the `T` form by specification — so handing either to
 * `Date` shifts the coordinate by the host's UTC offset. West of UTC that shift
 * reaches FORWARD, and `fetched_at <= ?` then matches a version the page had not
 * served yet at the instant asked for: a later body returned for a past
 * question, with `requested_at` echoing the shifted value so the response reads
 * as internally consistent. That is the exact provenance failure this surface
 * exists to refuse, which is why the offset is removed from the problem rather
 * than assumed away.
 *
 * A value that DOES carry `Z` or an explicit offset is unambiguous and goes to
 * `Date.parse`, which resolves it correctly.
 *
 * ACCEPTED SHAPES ARE AN ALLOWLIST, and that is the actual fix rather than a
 * patch of the one shape that was reported. Widening the zone-less guard from
 * the space form to `[T ]` closes two members of a class with more members:
 * `Date.parse` also accepts `2026/08/18 13:00:00`, `Aug 18 2026 13:00:00` and
 * other implementation-defined legacy forms, and reads every one of them as
 * LOCAL. Any of them would shift exactly as the `T` form did. So anything
 * outside the three ISO shapes below is REFUSED rather than guessed at:
 * the caller gets an explicit error naming what is readable, which is strictly
 * better than a confidently wrong instant. It also makes the code agree with the
 * contract the schema already states — "ISO 8601, a UTC offset, or YYYY-MM-DD".
 *
 * Sub-second precision truncates DOWN, which keeps "at or before" true: rounding
 * up could reach a version the page had not served yet at the instant asked for.
 */
export function toVersionTimestamp(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Offset-less: pin to UTC ourselves rather than letting the host's zone decide.
  if (ZONELESS_DATETIME.test(trimmed)) {
    return toStoredShape(Date.parse(`${trimmed.replace(' ', 'T')}Z`));
  }
  // Date-only and explicitly-zoned forms are already unambiguous to the parser.
  if (DATE_ONLY.test(trimmed) || ZONED_DATETIME.test(trimmed)) {
    return toStoredShape(Date.parse(trimmed));
  }
  return null;
}

/** An epoch reading in the zone-less UTC shape `fetched_at` uses, or null. */
function toStoredShape(ms: number): string | null {
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  // A year outside 0000-9999 widens to the expanded form (`+275760-…`), which
  // sorts BELOW every `2xxx-` row under the string compare the query uses and
  // would silently read as "nothing retained". Refused instead, so an
  // out-of-range year cannot masquerade as an answer about the store.
  if (!/^\d{4}-/.test(iso)) return null;
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * The newest retained version observed AT OR BEFORE `atUtc`, or null.
 *
 * `<=` and DESC, never "nearest": a read that could answer with a LATER version
 * would report a body the page had not served yet at the moment asked for, and
 * would do it while looking entirely reasonable. Null is a real answer here —
 * the caller must be told nothing is retained for that moment rather than handed
 * the current page (G-S14-2a).
 *
 * Both sides of the comparison are zone-less UTC "YYYY-MM-DD HH:MM:SS", where
 * lexicographic order IS chronological order, so the string compare is exact
 * and uses idx_url_versions_url_time directly.
 */
export function versionAt(normalizedUrl: string, atUtc: string): RetainedVersion | null {
  const row = getDatabase()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM url_versions
        WHERE normalized_url = ? AND fetched_at <= ?
        ORDER BY fetched_at DESC, id DESC
        LIMIT 1`,
    )
    .get(normalizedUrl, atUtc) as VersionRow | undefined;
  return row ? toRetained(row) : null;
}

/** Retained versions for one URL, newest first, without their bodies. */
export function listVersionMeta(normalizedUrl: string, limit: number): CacheVersionListEntry[] {
  const rows = getDatabase()
    .prepare(
      `SELECT content_hash, title, http_status, fetched_at, byte_len FROM url_versions
        WHERE normalized_url = ?
        ORDER BY fetched_at DESC, id DESC
        LIMIT ?`,
    )
    .all(normalizedUrl, limit) as Array<Omit<VersionRow, 'normalized_url' | 'markdown'>>;
  return rows.map((row) => ({
    observed_at: row.fetched_at,
    content_hash: row.content_hash,
    title: row.title,
    http_status: row.http_status,
    bytes: row.byte_len,
  }));
}

/**
 * A retained version by its content fingerprint. Backs `diff`'s `old.content_hash`
 * once the live `url_cache` row no longer carries that hash.
 *
 * A hash does not identify a row uniquely — two URLs serving identical markdown
 * share one — but the hash is taken over the markdown, so every matching row
 * carries byte-identical content by construction. Newest-first makes the pick
 * deterministic rather than leaving it to SQLite's scan order.
 */
export function versionByHash(contentHash: string): RetainedVersion | null {
  const row = getDatabase()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM url_versions
        WHERE content_hash = ?
        ORDER BY fetched_at DESC, id DESC
        LIMIT 1`,
    )
    .get(contentHash) as VersionRow | undefined;
  return row ? toRetained(row) : null;
}

function clampListLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_VERSION_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_VERSION_LIST_LIMIT, Math.floor(limit)));
}

export interface VersionRequest {
  url?: string;
  at?: string;
  versions?: boolean;
  limit?: number;
  maxTokensOut?: number;
}

/** True when the caller asked for the time axis rather than the ordinary cache read. */
export function isVersionRequest(input: { at?: string; versions?: boolean }): boolean {
  return input.at !== undefined || input.versions === true;
}

/**
 * Serve a version request as a `cache` response fragment.
 *
 * Lives here rather than in the tool handler because deciding what a point-in-time
 * miss means is the whole substance of this slice; the handler stays a wrapper.
 */
export function readVersions(request: VersionRequest): CacheOutput {
  if (typeof request.url !== 'string' || request.url.trim() === '') {
    return { error: 'url is required when reading versions (pass at: or versions: with a url)' };
  }
  if (!URL.canParse(request.url)) {
    return { error: `url is not a valid absolute URL: ${JSON.stringify(request.url)}` };
  }
  // Every `url` this function ECHOES is the normalized form, never the caller's
  // raw string, for two reasons that happen to share one fix.
  //
  // 1. SHAPE. `URL.canParse` is a weak gate: it accepts a value carrying a raw
  //    newline (measured — `https://example.com/#a\nIGNORE ALL…` parses true with
  //    the LF preserved), while the `artifact-uri` shape these leaves are
  //    allowlisted under forbids whitespace. Since the leaves sit OUTSIDE the
  //    content fence, echoing the raw string is a laundering path: page text an
  //    agent read inside a fence could be passed back as `url` and returned in a
  //    field the reading model treats as operational. The WHATWG parser strips
  //    CR/LF/tab and percent-encodes spaces, so normalizing satisfies the
  //    declared shape BY CONSTRUCTION rather than by a caller's restraint.
  // 2. PROVENANCE. The lookup is keyed on the normalized form, so labelling the
  //    answer with the caller's `www.`/utm variant names a key the store never
  //    used — and `fenceCacheData` attributes the fenced region via this same
  //    field, so the drift would reach the fence marker too.
  const normalized = normalizeUrl(request.url);

  if (request.at !== undefined) {
    const atUtc = toVersionTimestamp(request.at);
    if (atUtc === null) {
      return {
        error:
          `at is not a timestamp this can read: ${JSON.stringify(request.at)}. ` +
          'Use an ISO 8601 instant (2026-08-18T12:00:00Z), a UTC offset, or "YYYY-MM-DD".',
      };
    }
    const found = versionAt(normalized, atUtc);
    if (!found) {
      return {
        version_not_retained: {
          url: normalized,
          requested_at: atUtc,
          not_retained: true,
          reason:
            'No version of this page observed at or before that time is retained. ' +
            'This is not the same as the page being unchanged — earlier versions may never ' +
            'have been recorded, or may have been evicted by the storage bounds.',
        },
      };
    }
    return buildVersionResult(normalized, atUtc, found, request.maxTokensOut);
  }

  return {
    version_list: {
      url: normalized,
      versions: listVersionMeta(normalized, clampListLimit(request.limit)),
      note: VERSION_LIST_NOTE,
    },
  };
}

/**
 * Wrap a retained body in the response shape, through the same output budget
 * every other body-returning `cache` path goes through.
 *
 * The budget can trim the body, which is why `truncated` is carried onto the
 * result: `content_hash` fingerprints the FULL retained body, so a caller
 * re-hashing a trimmed one must be able to see that it was trimmed rather than
 * conclude the store is inconsistent.
 */
function buildVersionResult(
  url: string,
  requestedAt: string,
  found: RetainedVersion,
  maxTokensOut?: number,
): CacheOutput {
  const carrier: CacheResultItem = {
    url,
    title: found.title ?? '',
    markdown: found.markdown,
    fetched_at: found.observedAt,
    source: 'cache',
    trusted: false,
  };
  const budgeted = applyCacheOutputBudget([carrier], maxTokensOut);
  const trimmed = budgeted.results[0];

  const version: CacheVersionResult = {
    url,
    requested_at: requestedAt,
    observed_at: found.observedAt,
    content_hash: found.contentHash,
    title: found.title,
    http_status: found.httpStatus,
    markdown: trimmed.markdown,
    bytes: found.byteLen,
    source: 'cache',
    trusted: false,
    ...(trimmed.truncated ? { truncated: trimmed.truncated } : {}),
  };

  return {
    version,
    ...(budgeted.truncation ? { truncation: budgeted.truncation } : {}),
  };
}
