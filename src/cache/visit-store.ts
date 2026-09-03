import { createHash } from 'node:crypto';
import { getDatabase } from './db.js';
import { normalizeUrl, sanitizeFtsQuery } from './store.js';
import { evictVisitVectors, searchVisitVectors } from './visit-vec.js';
import { buildRankMap, reciprocalRankFusion, sortByRRFScore } from '../search/rrf.js';
import { createLogger } from '../logger.js';

const log = createLogger('cache');

/**
 * SD7 A-18-5/A-18-6 — the visits store: history WITH content, agent-partitioned.
 *
 * What this is for: a human browses, and afterwards can search what they actually read,
 * offline, by its text — the thing a browser's history has never been able to answer. The
 * substrate is two tables (`studio_visits` + hash-deduped `studio_visit_pages`) with their
 * own FTS5 index, created by `021-studio-visits`.
 *
 * What this is NOT: an agent-facing corpus. These tables are absent from `BROKER_TABLES`,
 * from every artifact provider and from the `url_cache_fts` / vec unions that `cache`,
 * `find_similar` and `research` read. Law 4 says the user's own tabs are a separate group,
 * invisible to every agent; A-18-5 extends that to what those tabs contained. The partition
 * is asserted at the read paths by `tests/unit/cache/visits-agent-partition.test.ts`, and it
 * is a merge condition, not a nicety.
 */

/** A visit as the capture seam observes it. */
export interface VisitInput {
  /** The visit's own full URL, query string included — history without it is useless. */
  url: string;
  title: string | null;
  /** Zone-less UTC "YYYY-MM-DD HH:MM:SS". Defaults to now. */
  ts?: string;
  tabId: string;
  /** SD12 spaces; the schema's own default is `default`. */
  spaceId?: string;
  /** Set when the tab is owned by a run — attribution, never a join. */
  runId?: string | null;
  /** The captured page text, or null when nothing was captured for this visit. */
  markdown?: string | null;
  /** Override the retention bounds this write is held to. */
  retention?: Partial<VisitRetentionBounds>;
}

export type VisitSkipReason = 'capture_off' | 'retention_disabled' | 'error';

export interface RecordVisitResult {
  /** Whether the visit row was written. */
  stored: boolean;
  /** Whether a body was stored (or already present) for it. */
  bodyStored: boolean;
  reason?: VisitSkipReason;
}

export interface VisitRetentionBounds {
  /** Newest-first row ceiling on `studio_visits`. */
  maxVisits: number;
  /** Ceiling on the SUM of retained body bytes — bodies, not visit rows. */
  maxBytes: number;
  /** Age ceiling on visit rows, in days. */
  maxAgeDays: number;
}

/**
 * Visits' OWN bounds, deliberately not the corpus version bounds (`corpusMax*`).
 *
 * A visit is written on navigation-settle for every page a human opens, so the row count
 * grows with browsing rather than with fetching: 100k rows is roughly a year of heavy daily
 * use, and the row itself is small. The byte ceiling matches the version store's 512 MB
 * because it bounds the same kind of thing (retained page bodies on one machine's disk), and
 * 180 days matches it because a history you cannot search back through a project's lifetime
 * is not the feature.
 *
 * These are DEFAULTS, not policy: the caller passes `retention` to hold a write to different
 * bounds. The config keys that will carry a user's choice belong with the app-side capture
 * seam that owns the settings surface — this module deliberately reads no config, so it can
 * be exercised without one.
 */
export const VISIT_RETENTION_DEFAULTS: Readonly<VisitRetentionBounds> = Object.freeze({
  maxVisits: 100_000,
  maxBytes: 512 * 1024 * 1024,
  maxAgeDays: 180,
});

export interface VisitRow {
  id: number;
  url: string;
  normalizedUrl: string;
  title: string | null;
  ts: string;
  tabId: string;
  spaceId: string;
  runId: string | null;
  contentHash: string | null;
}

export interface VisitSearchRow extends VisitRow {
  /**
   * BM25 rank from the visits FTS index — lower is better, as FTS5 reports it.
   *
   * NULL for a row the keyword leg never matched: a hybrid result can arrive on
   * the semantic side alone, and reporting a fabricated 0 there would make the
   * one number a caller might sort on mean two different things.
   */
  rank: number | null;
  snippet: string;
}

/** How a visits search was answered. Mirrors `HybridSearchMethod` — the same word, the same meaning. */
export type VisitSearchMethod = 'hybrid' | 'fts';

export interface VisitSearchResult {
  results: VisitSearchRow[];
  /**
   * `'fts'` whenever the semantic side could not run — no embedding provider, no
   * vector extension, an empty index. Degradation is reported rather than
   * inferred, exactly as #362 made `runHybridSearch` report it, so a UI that
   * promises "searched by meaning" can say when it did not.
   */
  method: VisitSearchMethod;
}

export interface VisitPage {
  contentHash: string;
  markdown: string;
  byteLen: number;
  createdAt: string;
}

export interface ListVisitsOptions {
  limit?: number;
  cursor?: string;
  /** Exact host scope (apex and subdomains stay separate), as the 3bf per-site control means it. */
  site?: string;
  /** A single UTC calendar day, `YYYY-MM-DD`. */
  day?: string;
}

export interface VisitsPage {
  rows: VisitRow[];
  next_cursor: string | null;
}

export interface SearchVisitsOptions {
  query: string;
  limit?: number;
  site?: string;
}

export interface DeleteVisitsScope {
  site?: string;
  day?: string;
}

export interface DeleteVisitsResult {
  visits: number;
  bodies: number;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
/**
 * Candidate depth per leg before fusion, and the RRF constant.
 *
 * Deliberately the same numbers `hybrid-search.ts` uses for the corpus. Two
 * fusions over the same kind of thing that disagreed on how deep each leg
 * reaches would rank the Library and the history differently for reasons no
 * user could see, and the first person to compare them would be right to call
 * it a bug.
 */
const SEARCH_CANDIDATE_FLOOR = 50;
const SEARCH_CANDIDATE_FACTOR = 5;
const RRF_K = 60;
/** Characters of body head shown for a hit that only the semantic leg found. */
const SEMANTIC_SNIPPET_CHARS = 160;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function nowUtc(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * The host a per-site control is keyed on: lower-cased, `www.` stripped, port dropped.
 *
 * Deliberately the same normalisation `normalizeUrl` applies to a URL's hostname, so a
 * capture-off decision recorded from a settings screen and a host derived from a visited URL
 * cannot disagree.
 */
function visitHost(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  return parsed.hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Origin-prefix predicate for an exact host, over both schemes and with or without a port.
 *
 * Mirrors `addExactDomainFilter` in `store.ts` rather than inventing a second host scoping:
 * a site control that matched a different set of rows than the Library's host facet would be
 * a control the user cannot verify. `example.com` therefore does NOT match
 * `example.com.evil.test` — a prefix of a host is a different site.
 */
function siteConditions(column: string, host: string): { sql: string; params: string[] } {
  const params: string[] = [];
  const clauses: string[] = [];
  for (const origin of [`http://${host}`, `https://${host}`]) {
    clauses.push(`${column} = ?`, `${column} LIKE ?`, `${column} LIKE ?`);
    params.push(origin, `${origin}/%`, `${origin}:%`);
  }
  return { sql: `(${clauses.join(' OR ')})`, params };
}

function assertDay(day: string): string {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new Error(`invalid visit day (expected a UTC YYYY-MM-DD calendar day): ${day}`);
  }
  return day;
}

function resolveBounds(overrides?: Partial<VisitRetentionBounds>): VisitRetentionBounds {
  return { ...VISIT_RETENTION_DEFAULTS, ...overrides };
}

/**
 * Any bound at or below zero DISABLES recording — it does not purge what is already stored.
 *
 * The asymmetry is the point, and it is the same one `version-store.ts` records: a user
 * turning capture off is saying "stop recording", not "destroy my history", and the two are
 * different consents. Purging is what `deleteVisits` is for, and the user has to ask.
 */
function isDisabled(bounds: VisitRetentionBounds): boolean {
  return bounds.maxVisits <= 0 || bounds.maxBytes <= 0 || bounds.maxAgeDays <= 0;
}

/** Whether this host's pages may be captured. An absent decision is NOT an opt-out. */
export function isSiteCaptureEnabled(site: string): boolean {
  try {
    const row = getDatabase()
      .prepare('SELECT capture_enabled FROM studio_visit_site_prefs WHERE host = ?')
      .get(visitHost(site)) as { capture_enabled: number } | undefined;
    return row ? row.capture_enabled === 1 : true;
  } catch (err) {
    // Fail CLOSED on an unreadable preference: capturing a site the user may have excluded is
    // the unrecoverable direction, and a missing visit is not.
    log.warn('isSiteCaptureEnabled failed', { site, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Record this host's capture decision. Turning capture off deletes nothing — see `isDisabled`.
 */
export function setSiteCapture(site: string, enabled: boolean): void {
  const host = visitHost(site);
  getDatabase()
    .prepare(
      `INSERT INTO studio_visit_site_prefs (host, capture_enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET capture_enabled = excluded.capture_enabled,
                                       updated_at = excluded.updated_at`,
    )
    .run(host, enabled ? 1 : 0, nowUtc());
}

/** Every host with a recorded capture decision, so a settings surface can show them. */
export function listSiteCapturePrefs(): Array<{ host: string; captureEnabled: boolean; updatedAt: string }> {
  const rows = getDatabase()
    .prepare('SELECT host, capture_enabled, updated_at FROM studio_visit_site_prefs ORDER BY host')
    .all() as Array<{ host: string; capture_enabled: number; updated_at: string }>;
  return rows.map((r) => ({ host: r.host, captureEnabled: r.capture_enabled === 1, updatedAt: r.updated_at }));
}

/**
 * Evict until every bound holds, inside the caller's transaction so no observer ever sees the
 * store above a bound.
 *
 * Ordered age → rows → bodies because the cheap global bound frees rows the other two would
 * otherwise have to account for, and because the body sweep's input is whatever the row
 * bounds left referenced.
 */
function evict(db: ReturnType<typeof getDatabase>, bounds: VisitRetentionBounds): void {
  db.prepare(`DELETE FROM studio_visits WHERE ts < datetime('now', ?)`).run(`-${bounds.maxAgeDays} days`);

  db.prepare(
    `DELETE FROM studio_visits
     WHERE id NOT IN (
       SELECT id FROM studio_visits ORDER BY ts DESC, id DESC LIMIT ?
     )`,
  ).run(bounds.maxVisits);

  // Bodies nothing points at any more. A body is shared by every visit to the same unchanged
  // page, so it can only go once the LAST of them has.
  dropBodies(
    db,
    `SELECT content_hash FROM studio_visit_pages
     WHERE content_hash NOT IN (SELECT content_hash FROM studio_visits WHERE content_hash IS NOT NULL)`,
    [],
  );

  // The byte bound is spent on bodies and NOT on visit rows: the record of having read a page
  // is history in its own right, and it costs a few hundred bytes against a body's kilobytes.
  // A visit whose body was swept keeps its metadata and loses its text — which is exactly what
  // a bounded local archive can honestly promise.
  //
  // Short-circuited on a plain SUM, as `version-store.evict` is: the windowed sweep below runs
  // on the capture path for every navigation, and a browsing session that never approaches the
  // budget must not pay for a window over the whole table each time.
  const total = db.prepare('SELECT COALESCE(SUM(byte_len), 0) AS total FROM studio_visit_pages').get() as {
    total: number;
  };
  if (total.total <= bounds.maxBytes) return;

  dropBodies(
    db,
    `SELECT content_hash FROM studio_visit_pages
     WHERE content_hash NOT IN (
       SELECT content_hash FROM (
         SELECT content_hash, SUM(byte_len) OVER (ORDER BY created_at DESC, rowid DESC) AS running
         FROM studio_visit_pages
       )
       WHERE running <= ?
     )`,
    [bounds.maxBytes],
  );
}

/**
 * Delete the bodies a SELECT names, and the vectors derived from them, together.
 *
 * The sweep reads the hashes first rather than issuing a bare DELETE because a
 * body's embedding is not stored beside it — it lives in the shared vector
 * index under `visit:<hash>`, and nothing there references `studio_visit_pages`
 * to cascade from. A body swept for retention whose vector survived would stay
 * findable by meaning after its text was gone: the search would return a row
 * whose content the store can no longer show, which is worse than either
 * keeping it or losing it cleanly.
 */
function dropBodies(db: ReturnType<typeof getDatabase>, selectSql: string, params: unknown[]): number {
  const hashes = (db.prepare(selectSql).all(...params) as Array<{ content_hash: string }>).map(
    (r) => r.content_hash,
  );
  if (hashes.length === 0) return 0;
  const placeholders = hashes.map(() => '?').join(',');
  const removed = db
    .prepare(`DELETE FROM studio_visit_pages WHERE content_hash IN (${placeholders})`)
    .run(...hashes).changes;
  evictVisitVectors(db, hashes);
  return removed;
}

/**
 * Record one visit, and the page text it showed.
 *
 * NEVER THROWS. A failure to record history must not fail the navigation it rides along with —
 * the same contract `recordVersion` carries, for the same reason: the user's browsing is the
 * hot path and this is a side effect of it.
 */
export function recordVisit(input: VisitInput): RecordVisitResult {
  try {
    const bounds = resolveBounds(input.retention);
    if (isDisabled(bounds)) return { stored: false, bodyStored: false, reason: 'retention_disabled' };
    if (!isSiteCaptureEnabled(input.url)) return { stored: false, bodyStored: false, reason: 'capture_off' };

    const db = getDatabase();
    const normalizedUrl = normalizeUrl(input.url);
    const ts = input.ts ?? nowUtc();
    const markdown = input.markdown ?? null;
    const byteLen = markdown === null ? 0 : Buffer.byteLength(markdown, 'utf8');
    // A body that alone exceeds the whole byte budget can never be retained, so it is refused
    // before it is ever written: an inserted-then-swept body has already pushed the database
    // file's high-water mark up, and db.ts sets no auto_vacuum. The VISIT still lands — losing
    // the record of a page because its text was oversized would be the wrong trade.
    const keepBody = markdown !== null && byteLen > 0 && byteLen <= bounds.maxBytes;
    const contentHash = keepBody ? createHash('sha256').update(markdown!).digest('hex') : null;

    db.transaction(() => {
      if (contentHash) {
        // ON CONFLICT re-times an existing body to when it was last observed rather than
        // rejecting the write: that instant is what the byte sweep orders on, so a page the
        // user keeps coming back to is not evicted as though it were untouched since first read.
        db.prepare(
          `INSERT INTO studio_visit_pages (content_hash, markdown, byte_len, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(content_hash) DO UPDATE SET created_at = excluded.created_at`,
        ).run(contentHash, markdown, byteLen, ts);
      }
      db.prepare(
        `INSERT INTO studio_visits (url, normalized_url, title, ts, tab_id, space_id, run_id, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.url,
        normalizedUrl,
        input.title,
        ts,
        input.tabId,
        input.spaceId ?? 'default',
        input.runId ?? null,
        contentHash,
      );
      evict(db, bounds);
    })();

    return { stored: true, bodyStored: contentHash !== null };
  } catch (err) {
    log.warn('recordVisit failed', {
      url: input.url,
      error: err instanceof Error ? err.message : String(err),
    });
    return { stored: false, bodyStored: false, reason: 'error' };
  }
}

/** Read one stored body by its hash — the offline-reading path for a visit. */
export function readVisitPage(contentHash: string): VisitPage | null {
  const row = getDatabase()
    .prepare('SELECT content_hash, markdown, byte_len, created_at FROM studio_visit_pages WHERE content_hash = ?')
    .get(contentHash) as { content_hash: string; markdown: string; byte_len: number; created_at: string } | undefined;
  if (!row) return null;
  return {
    contentHash: row.content_hash,
    markdown: row.markdown,
    byteLen: row.byte_len,
    createdAt: row.created_at,
  };
}

interface VisitDbRow {
  id: number;
  url: string;
  normalized_url: string;
  title: string | null;
  ts: string;
  tab_id: string;
  space_id: string;
  run_id: string | null;
  content_hash: string | null;
}

function toVisitRow(row: VisitDbRow): VisitRow {
  return {
    id: row.id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    title: row.title,
    ts: row.ts,
    tabId: row.tab_id,
    spaceId: row.space_id,
    runId: row.run_id,
    contentHash: row.content_hash,
  };
}

interface VisitCursor {
  v: 1;
  ts: string;
  id: number;
}

function encodeCursor(cursor: VisitCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): VisitCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('v' in parsed) ||
      parsed.v !== 1 ||
      !('ts' in parsed) ||
      typeof parsed.ts !== 'string' ||
      !('id' in parsed) ||
      !Number.isSafeInteger(parsed.id)
    ) {
      throw new Error('shape');
    }
    return parsed as VisitCursor;
  } catch {
    // Refused rather than treated as "start again": a page that silently restarts hands the
    // caller the newest rows a second time and looks like history repeating itself.
    throw new Error('invalid visit cursor');
  }
}

function scopeConditions(options: { site?: string; day?: string }): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  if (options.site) {
    const scoped = siteConditions('normalized_url', visitHost(options.site));
    sql.push(scoped.sql);
    params.push(...scoped.params);
  }
  if (options.day) {
    const day = assertDay(options.day);
    // Lexicographic on the zone-less UTC instant — the day IS the string's prefix, so this is a
    // range seek on idx_studio_visits_ts rather than a per-row date() call.
    sql.push('ts >= ? AND ts < ?');
    params.push(`${day} 00:00:00`, `${day} 24:00:00`);
  }
  return { sql, params };
}

/** Newest-first page of visits, keyset-paginated. */
export function listVisits(options: ListVisitsOptions = {}): VisitsPage {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const { sql: conditions, params } = scopeConditions(options);

  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    // Strict keyset on (ts, id): ties on ts are broken by id, so a second visit recorded in the
    // same second is neither skipped nor served twice.
    conditions.push('(ts < ? OR (ts = ? AND id < ?))');
    params.push(cursor.ts, cursor.ts, cursor.id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = getDatabase()
    .prepare(
      `SELECT id, url, normalized_url, title, ts, tab_id, space_id, run_id, content_hash
       FROM studio_visits
       ${where}
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as VisitDbRow[];

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map(toVisitRow),
    next_cursor: rows.length > limit && last ? encodeCursor({ v: 1, ts: last.ts, id: last.id }) : null,
  };
}

/**
 * Search what the human actually read — by keyword AND by meaning.
 *
 * Two legs, fused with RRF, keyed on `content_hash` because that is the identity
 * both legs speak: the FTS index is built on the deduped body table (A-363-4)
 * and one visit vector covers one body however many visits share it. Fusing on
 * the visit id instead would let a page read five times contribute five
 * independent ranks and outrank a better match read once.
 *
 * Degradation is explicit (`method`), never inferred from an empty result. The
 * semantic leg reaches only the visits partition of the shared vector store; the
 * partition is enforced in `SqliteVecStore`, not here — see `visit-vec.ts`.
 */
export async function searchVisits(options: SearchVisitsOptions): Promise<VisitSearchResult> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  // A semantic leg has no use for a hostile-FTS-expression guard, so a query that
  // sanitises down to nothing is still worth embedding. Only a blank query is
  // nothing to search for on either side.
  if (options.query.trim().length === 0) return { results: [], method: 'fts' };

  const candidateLimit = Math.max(SEARCH_CANDIDATE_FLOOR, limit * SEARCH_CANDIDATE_FACTOR);
  const ftsRows = ftsSearchVisits(options, candidateLimit);
  const vecHashes = await searchVisitVectors(options.query, candidateLimit);

  if (vecHashes === null) {
    return { results: ftsRows.slice(0, limit), method: 'fts' };
  }

  const ftsRankMap = buildRankMap(ftsRows.map((row) => row.contentHash ?? ''));
  ftsRankMap.delete('');
  const vecRankMap = buildRankMap(vecHashes);
  if (ftsRankMap.size === 0 && vecRankMap.size === 0) return { results: [], method: 'hybrid' };

  const ordered = sortByRRFScore(reciprocalRankFusion([ftsRankMap, vecRankMap], RRF_K));
  const ftsByHash = new Map<string, VisitSearchRow[]>();
  for (const row of ftsRows) {
    if (!row.contentHash) continue;
    const bucket = ftsByHash.get(row.contentHash);
    if (bucket) bucket.push(row);
    else ftsByHash.set(row.contentHash, [row]);
  }

  const results: VisitSearchRow[] = [];
  for (const [hash] of ordered) {
    if (results.length >= limit) break;
    // A hash the keyword leg already resolved is reused verbatim, snippet and
    // BM25 rank intact: re-reading its visits would be a second query for rows
    // already in hand, and would drop the highlighted snippet on the floor.
    const known = ftsByHash.get(hash);
    const rows = known ?? hydrateVisitsForHash(hash, options.site);
    for (const row of rows) {
      if (results.length >= limit) break;
      results.push(row);
    }
  }
  return { results, method: 'hybrid' };
}

/** The keyword leg: the visits FTS index, unchanged from the FTS-only shape #363 shipped. */
function ftsSearchVisits(options: SearchVisitsOptions, limit: number): VisitSearchRow[] {
  const match = sanitizeFtsQuery(options.query);
  if (!match) return [];

  const conditions: string[] = ['studio_visit_pages_fts MATCH ?'];
  const params: unknown[] = [match];
  if (options.site) {
    const scoped = siteConditions('v.normalized_url', visitHost(options.site));
    conditions.push(scoped.sql);
    params.push(...scoped.params);
  }

  try {
    const rows = getDatabase()
      .prepare(
        `SELECT v.id, v.url, v.normalized_url, v.title, v.ts, v.tab_id, v.space_id, v.run_id, v.content_hash,
                studio_visit_pages_fts.rank AS rank,
                snippet(studio_visit_pages_fts, 0, '', '', '…', 12) AS snippet
         FROM studio_visit_pages_fts
         JOIN studio_visits v ON v.content_hash = studio_visit_pages_fts.content_hash
         WHERE ${conditions.join(' AND ')}
         ORDER BY studio_visit_pages_fts.rank, v.ts DESC, v.id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<VisitDbRow & { rank: number; snippet: string }>;
    return rows.map((row) => ({ ...toVisitRow(row), rank: row.rank, snippet: row.snippet }));
  } catch (err) {
    // `sanitizeFtsQuery` passes FTS5 operators through, so a caller can still hand us an
    // unparseable expression (`a AND (`). A search box must not turn that into a stack trace.
    log.warn('searchVisits failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * The visits behind a body the semantic leg matched but the keyword leg did not.
 *
 * Newest-first, and site-scoped by the SAME predicate the keyword leg uses: a
 * per-site filter that held on one leg and not the other would show the user a
 * row from a site they had just excluded.
 */
function hydrateVisitsForHash(contentHash: string, site?: string): VisitSearchRow[] {
  const conditions: string[] = ['v.content_hash = ?'];
  const params: unknown[] = [contentHash];
  if (site) {
    const scoped = siteConditions('v.normalized_url', visitHost(site));
    conditions.push(scoped.sql);
    params.push(...scoped.params);
  }
  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT v.id, v.url, v.normalized_url, v.title, v.ts, v.tab_id, v.space_id, v.run_id, v.content_hash
         FROM studio_visits v
         WHERE ${conditions.join(' AND ')}
         ORDER BY v.ts DESC, v.id DESC
         LIMIT ?`,
      )
      .all(...params, MAX_SEARCH_LIMIT) as VisitDbRow[];
    if (rows.length === 0) return [];
    const body = db
      .prepare('SELECT markdown FROM studio_visit_pages WHERE content_hash = ?')
      .get(contentHash) as { markdown: string } | undefined;
    const snippet = semanticSnippet(body?.markdown ?? '');
    // `rank: null` is the honest value: no BM25 score exists for a row the
    // keyword leg never saw.
    return rows.map((row) => ({ ...toVisitRow(row), rank: null, snippet }));
  } catch (err) {
    log.warn('visit hydration failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * The opening of a body, for a hit no keyword matched.
 *
 * FTS5's `snippet()` centres on the matched term; a semantic hit has no term to
 * centre on, so the head of the page is the honest excerpt rather than a
 * highlighted one. The trailing ellipsis is the same token the FTS leg uses, so
 * a UI renders both the same way.
 */
function semanticSnippet(markdown: string): string {
  const flat = markdown.replace(/\s+/g, ' ').trim();
  if (flat.length <= SEMANTIC_SNIPPET_CHARS) return flat;
  const cut = flat.slice(0, SEMANTIC_SNIPPET_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Delete history by site, by day, or by both — 3bf's two controls.
 *
 * A scope is REQUIRED. "Delete everything" is a different, louder consent than "delete this
 * site" or "delete today", and an unscoped call is far more likely to be a caller that lost
 * its filter than a user who meant it.
 */
export function deleteVisits(scope: DeleteVisitsScope): DeleteVisitsResult {
  if (!scope.site && !scope.day) {
    throw new Error('deleteVisits requires a scope: pass site, day, or both');
  }
  const { sql: conditions, params } = scopeConditions(scope);
  const where = conditions.join(' AND ');
  const db = getDatabase();

  return db.transaction(() => {
    const hashes = (
      db
        .prepare(
          `SELECT DISTINCT content_hash FROM studio_visits WHERE ${where} AND content_hash IS NOT NULL`,
        )
        .all(...params) as Array<{ content_hash: string }>
    ).map((r) => r.content_hash);

    const visits = db.prepare(`DELETE FROM studio_visits WHERE ${where}`).run(...params).changes;

    // A body goes only once no surviving visit references it: two sites that served byte-identical
    // pages share one row, and clearing one of them must not take the other's text.
    let bodies = 0;
    const stillReferenced = db.prepare('SELECT 1 FROM studio_visits WHERE content_hash = ? LIMIT 1');
    const dropBody = db.prepare('DELETE FROM studio_visit_pages WHERE content_hash = ?');
    const orphaned: string[] = [];
    for (const hash of hashes) {
      if (stillReferenced.get(hash)) continue;
      bodies += dropBody.run(hash).changes;
      orphaned.push(hash);
    }
    // The user asked for this text to be gone. Semantic search reads a separate
    // index, so "gone" has to be said there too.
    evictVisitVectors(db, orphaned);
    return { visits, bodies };
  })();
}
