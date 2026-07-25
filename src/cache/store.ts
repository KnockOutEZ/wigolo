import { createHash } from 'node:crypto';
import { getDatabase } from './db.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { RawFetchResult, ExtractionResult, CachedContent, SearchResultItem, CacheStats, ContentCompleteness } from '../types.js';

const log = createLogger('cache');

/**
 * Sanitize a user query for sqlite FTS5 MATCH.
 *
 * Why: bare tokens with `.` / `-` / `/` / `:` / digits-with-dot
 * (e.g. "5.4", "x-y", "https://foo") raise `fts5: syntax error near "."`.
 * Quoting tokens that aren't pure word-chars lets FTS5 treat them as phrases.
 * Already-quoted phrases and explicit operators (AND/OR/NOT/parens) pass through.
 */
export function sanitizeFtsQuery(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return '';
  if (/^".*"$/.test(trimmed)) return trimmed;
  const tokens = trimmed.match(/"[^"]*"|\S+/g) ?? [];
  const RESERVED = new Set(['AND', 'OR', 'NOT', '(', ')']);
  return tokens.map(tok => {
    if (tok.startsWith('"') && tok.endsWith('"')) return tok;
    if (RESERVED.has(tok)) return tok;
    if (/^\w+\*?$/.test(tok)) return tok;
    return `"${tok.replace(/"/g, '""')}"`;
  }).join(' ');
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
]);

export function normalizeUrl(url: string): string {
  const parsed = new URL(url);

  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) {
      parsed.searchParams.delete(key);
    }
  }

  parsed.searchParams.sort();

  let result = parsed.toString();

  // Strip trailing slash from path (but not root)
  if (parsed.pathname !== '/' && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  // Remove trailing slash from origin-only URLs too
  if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
    result = result.replace(/\/$/, '');
  }

  return result;
}

function toIsoSeconds(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

const ZONELESS_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// Timestamps are persisted by toIsoSeconds() (and SQLite's datetime('now'))
// as zone-less UTC: "YYYY-MM-DD HH:MM:SS". JavaScript's Date parser treats
// that space-separated form as LOCAL time, which shifts every expiry
// comparison by the host's UTC offset. Re-attach the UTC marker before
// parsing; leave any other format untouched.
function parseUtcTimestamp(value: string): number {
  const normalized = ZONELESS_UTC_TIMESTAMP.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return new Date(normalized).getTime();
}

export function cacheContent(result: RawFetchResult, extraction: ExtractionResult): void {
  try {
    const db = getDatabase();
    const config = getConfig();

    const normalizedUrl = normalizeUrl(result.finalUrl || result.url);
    const contentHash = createHash('sha256').update(extraction.markdown).digest('hex');

    // SINGLE source of truth for `now` in this write. Both
    // `fetched_at` (returned to callers as `cached_at`) and the derived
    // `expires_at` use this same Date instance. `getCacheStats().newest`
    // reads MAX(fetched_at) — same column, same value, no clock drift.
    // Future writers MUST NOT swap one of these for SQLite's
    // `datetime('now')` (which has its own clock + timezone surface)
    // unless the OTHER also moves; mixing JS + SQL clocks is what produces
    // a cached_at / newest mismatch.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.cacheTtlContent * 1000);

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO url_cache (
        url, normalized_url, title, markdown, raw_html,
        metadata, links, images, fetch_method, extractor_used,
        content_hash, fetched_at, expires_at, http_status,
        content_completeness_level, content_completeness_reason, content_completeness_settled_by
      )
      VALUES (
        @url, @normalizedUrl, @title, @markdown, @rawHtml,
        @metadata, @links, @images, @fetchMethod, @extractorUsed,
        @contentHash, @fetchedAt, @expiresAt, @httpStatus,
        @completenessLevel, @completenessReason, @completenessSettledBy
      )
    `);

    const completeness = result.contentCompleteness;
    stmt.run({
      url: result.url,
      normalizedUrl,
      title: extraction.title,
      markdown: extraction.markdown,
      rawHtml: result.html,
      metadata: JSON.stringify(extraction.metadata),
      links: JSON.stringify(extraction.links),
      images: JSON.stringify(extraction.images),
      fetchMethod: result.method,
      extractorUsed: extraction.extractor,
      contentHash: contentHash,
      fetchedAt: toIsoSeconds(now),
      expiresAt: toIsoSeconds(expiresAt),
      // Persist upstream status so cache lookups can branch
      // on 200 vs 404 vs 5xx instead of trusting body-hash alone.
      httpStatus: typeof result.statusCode === 'number' ? result.statusCode : null,
      // Render-completeness label (browser tier only). Null when the tier
      // produced no label, so a legacy/HTTP-tier row reads back as unknown.
      completenessLevel: completeness?.level ?? null,
      completenessReason: completeness?.reason ?? null,
      completenessSettledBy: completeness?.settled_by ?? null,
    });
  } catch (err) {
    log.warn('cacheContent failed', {
      url: result.url,
      finalUrl: result.finalUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface DbRow {
  id: number;
  url: string;
  normalized_url: string;
  title: string;
  markdown: string;
  raw_html: string;
  metadata: string;
  links: string;
  images: string;
  fetch_method: string;
  extractor_used: string;
  content_hash: string;
  fetched_at: string;
  expires_at: string | null;
  // Nullable so legacy rows from before the column existed
  // still hydrate cleanly. Migration 006 adds the column without a default.
  http_status: number | null;
  // Nullable content-completeness columns (migration 009). Undefined on a
  // SELECT * over a legacy row whose table predates the columns; null when the
  // row exists but the tier produced no label.
  content_completeness_level?: string | null;
  content_completeness_reason?: string | null;
  content_completeness_settled_by?: string | null;
}

function rowToCachedContent(row: DbRow): CachedContent {
  // Reconstruct the completeness label only when a level was persisted. A
  // legacy row (columns absent → undefined) or a label-less row (null) yields
  // an undefined contentCompleteness, matching the "unknown" HTTP/TLS shape.
  const level = row.content_completeness_level ?? null;
  const contentCompleteness: ContentCompleteness | undefined = level
    ? {
        level: level as ContentCompleteness['level'],
        reason: (row.content_completeness_reason ?? 'empty') as ContentCompleteness['reason'],
        settled_by: (row.content_completeness_settled_by ?? 'budget') as ContentCompleteness['settled_by'],
      }
    : undefined;
  return {
    id: row.id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    title: row.title,
    markdown: row.markdown,
    rawHtml: row.raw_html,
    metadata: row.metadata,
    links: row.links,
    images: row.images,
    fetchMethod: row.fetch_method as CachedContent['fetchMethod'],
    extractorUsed: row.extractor_used as CachedContent['extractorUsed'],
    contentHash: row.content_hash,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    httpStatus: row.http_status ?? null,
    ...(contentCompleteness ? { contentCompleteness } : {}),
  };
}

export function getCachedContent(url: string): CachedContent | null {
  const db = getDatabase();
  const normalizedUrl = normalizeUrl(url);

  const row = db.prepare(`
    SELECT * FROM url_cache WHERE url = ? OR normalized_url = ? LIMIT 1
  `).get(url, normalizedUrl) as DbRow | undefined;

  return row ? rowToCachedContent(row) : null;
}

export function getCachedContentByNormalizedUrl(normalizedUrl: string): CachedContent | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM url_cache WHERE normalized_url = ? LIMIT 1',
  ).get(normalizedUrl) as DbRow | undefined;
  return row ? rowToCachedContent(row) : null;
}

export function getHashForNormalizedUrl(normalizedUrl: string): string | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT content_hash FROM url_cache WHERE normalized_url = ? LIMIT 1',
  ).get(normalizedUrl) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

/**
 * Cached HTTP status for change-detection. Returns `null`
 * when the row was persisted before migration 006 added the column, so
 * callers must treat `null` as "unknown, body-hash is authoritative".
 */
export function getHttpStatusForNormalizedUrl(normalizedUrl: string): number | null {
  try {
    const db = getDatabase();
    const row = db.prepare(
      'SELECT http_status FROM url_cache WHERE normalized_url = ? LIMIT 1',
    ).get(normalizedUrl) as { http_status: number | null } | undefined;
    return row?.http_status ?? null;
  } catch {
    return null;
  }
}

/**
 * Read content_hash and http_status in a single
 * prepared SELECT. Change-detection needs both on the hot path and
 * coalescing them halves the index lookup cost. Returns `{ hash: null,
 * status: null }` when the URL is absent; `status` is also `null` for
 * legacy rows persisted before migration 006 added the http_status
 * column. Defensive try/catch mirrors getHttpStatusForNormalizedUrl —
 * an unexpected schema state (column missing on a half-migrated DB)
 * degrades to "no cached entry" instead of throwing through the hot
 * path.
 */
export function getHashAndStatusForNormalizedUrl(
  normalizedUrl: string,
): { hash: string | null; status: number | null } {
  try {
    const db = getDatabase();
    const row = db.prepare(
      'SELECT content_hash, http_status FROM url_cache WHERE normalized_url = ? LIMIT 1',
    ).get(normalizedUrl) as { content_hash: string | null; http_status: number | null } | undefined;
    if (!row) return { hash: null, status: null };
    return {
      hash: row.content_hash ?? null,
      status: row.http_status ?? null,
    };
  } catch {
    return { hash: null, status: null };
  }
}

export function getMarkdownForNormalizedUrl(normalizedUrl: string): string | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT markdown FROM url_cache WHERE normalized_url = ? LIMIT 1',
  ).get(normalizedUrl) as { markdown: string } | undefined;
  return row ? row.markdown : null;
}

export function isExpired(cached: CachedContent): boolean {
  if (!cached.expiresAt) return false;
  return parseUtcTimestamp(cached.expiresAt) < Date.now();
}

export interface CacheLookupOptions {
  staleMaxSeconds?: number;
}

export function isCacheUsable(
  cached: CachedContent,
  opts: CacheLookupOptions = {},
): { usable: boolean; stale: boolean } {
  if (!cached.expiresAt) return { usable: true, stale: false };
  const expiresMs = parseUtcTimestamp(cached.expiresAt);
  const now = Date.now();
  if (expiresMs >= now) return { usable: true, stale: false };
  const staleMaxMs = (opts.staleMaxSeconds ?? 0) * 1000;
  if (now - expiresMs <= staleMaxMs) return { usable: true, stale: true };
  return { usable: false, stale: false };
}

export function searchCache(query: string): CachedContent[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT url_cache.*
    FROM url_cache
    JOIN url_cache_fts ON url_cache.id = url_cache_fts.rowid
    WHERE url_cache_fts MATCH ?
    ORDER BY rank
  `).all(sanitizeFtsQuery(query)) as DbRow[];

  return rows.map(rowToCachedContent);
}

export interface CachedSearchResult {
  query: string;
  results: SearchResultItem[];
  engines_used: string[];
  searched_at: string;
  stale?: boolean;
}

/** Filter parameters that participate in the search cache key. Changing any
 * of these must force a cache miss because the cached payload is filter-
 * dependent (sub-ticket 2.3). */
export interface SearchCacheFilters {
  category?: string | null;
  include_domains?: string[] | null;
  exclude_domains?: string[] | null;
  max_results?: number | null;
  from_date?: string | null;
  to_date?: string | null;
  language?: string | null;
  time_range?: string | null;
  exact_match?: boolean | null;
  search_depth?: string | null;
  reranker?: string | null;
}

function normaliseDomainList(list?: string[] | null): string[] | null {
  if (!list || list.length === 0) return null;
  const lower = list.map((d) => d.toLowerCase().trim()).filter((d) => d.length > 0);
  if (lower.length === 0) return null;
  return [...new Set(lower)].sort();
}

function hasAnyFilter(filters?: SearchCacheFilters): boolean {
  if (!filters) return false;
  return (
    filters.category != null ||
    (filters.include_domains?.length ?? 0) > 0 ||
    (filters.exclude_domains?.length ?? 0) > 0 ||
    filters.max_results != null ||
    filters.from_date != null ||
    filters.to_date != null ||
    filters.language != null ||
    filters.time_range != null ||
    filters.exact_match != null ||
    filters.search_depth != null ||
    filters.reranker != null
  );
}

/** Build a stable cache key string from a query and optional filter params.
 * Two requests with the same query but different filter values get distinct
 * keys, so cache lookups respect caller-specified constraints. */
export function buildSearchCacheKey(
  query: string,
  filters?: SearchCacheFilters,
): string {
  const q = query.toLowerCase().trim();
  if (!hasAnyFilter(filters)) return q;
  const fingerprint = {
    category: filters!.category ?? null,
    include_domains: normaliseDomainList(filters!.include_domains),
    exclude_domains: normaliseDomainList(filters!.exclude_domains),
    max_results: filters!.max_results ?? null,
    from_date: filters!.from_date ?? null,
    to_date: filters!.to_date ?? null,
    language: filters!.language ?? null,
    time_range: filters!.time_range ?? null,
    exact_match: filters!.exact_match ?? null,
    search_depth: filters!.search_depth ?? null,
    reranker: filters!.reranker ?? null,
  };
  return `${query} ${JSON.stringify(fingerprint)}`;
}

export function cacheSearchResults(
  query: string,
  results: SearchResultItem[],
  enginesUsed: string[],
): void {
  const db = getDatabase();
  const config = getConfig();

  const queryHash = createHash('sha256').update(query.toLowerCase().trim()).digest('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.cacheTtlSearch * 1000);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO search_cache (query, query_hash, results, engines_used, searched_at, expires_at)
    VALUES (@query, @queryHash, @results, @enginesUsed, @searchedAt, @expiresAt)
  `);

  stmt.run({
    query,
    queryHash,
    results: JSON.stringify(results),
    enginesUsed: JSON.stringify(enginesUsed),
    searchedAt: toIsoSeconds(now),
    expiresAt: toIsoSeconds(expiresAt),
  });
}

export function getCachedSearchResults(
  query: string,
  opts: CacheLookupOptions = {},
): CachedSearchResult | null {
  const db = getDatabase();
  const queryHash = createHash('sha256').update(query.toLowerCase().trim()).digest('hex');

  const row = db.prepare(
    'SELECT query, results, engines_used, searched_at, expires_at FROM search_cache WHERE query_hash = ? LIMIT 1',
  ).get(queryHash) as
    | { query: string; results: string; engines_used: string; searched_at: string; expires_at: string | null }
    | undefined;

  if (!row) return null;

  if (row.expires_at) {
    const expiresMs = parseUtcTimestamp(row.expires_at);
    const now = Date.now();
    if (expiresMs < now) {
      const staleMaxMs = (opts.staleMaxSeconds ?? 0) * 1000;
      if (now - expiresMs > staleMaxMs) return null;
      return {
        query: row.query,
        results: JSON.parse(row.results) as SearchResultItem[],
        engines_used: JSON.parse(row.engines_used) as string[],
        searched_at: row.searched_at,
        stale: true,
      };
    }
  }

  return {
    query: row.query,
    results: JSON.parse(row.results) as SearchResultItem[],
    engines_used: JSON.parse(row.engines_used) as string[],
    searched_at: row.searched_at,
  };
}

const DEFAULT_FILTERED_LIMIT = 100;

export function searchCacheFiltered(options: {
  query?: string;
  urlPattern?: string;
  since?: string;
  limit?: number;
}): CachedContent[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let fromClause = 'url_cache';

  if (options.query) {
    fromClause = 'url_cache JOIN url_cache_fts ON url_cache.id = url_cache_fts.rowid';
    conditions.push('url_cache_fts MATCH ?');
    params.push(sanitizeFtsQuery(options.query));
  }

  if (options.urlPattern) {
    conditions.push('url_cache.normalized_url GLOB ?');
    params.push(options.urlPattern);
  }

  if (options.since) {
    conditions.push('url_cache.fetched_at > datetime(?)');
    params.push(options.since);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderClause = options.query ? 'ORDER BY rank' : 'ORDER BY url_cache.fetched_at DESC';
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_FILTERED_LIMIT));

  const sql = `SELECT url_cache.* FROM ${fromClause} ${whereClause} ${orderClause} LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as DbRow[];
  return rows.map(rowToCachedContent);
}

/**
 * BM25-ranked FTS5 search across cached pages. Returns normalized URLs
 * paired with their rank score. `rank` from FTS5 is negative (lower is
 * better in sqlite ordering), so we flip the sign to surface a "higher is
 * better" score for consumers (e.g. RRF input).
 */
export function ftsSearchRanked(query: string, limit: number): Array<{ url: string; score: number }> {
  if (!query.trim() || limit <= 0) return [];
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT url_cache.normalized_url AS url, url_cache_fts.rank AS rank
    FROM url_cache
    JOIN url_cache_fts ON url_cache.id = url_cache_fts.rowid
    WHERE url_cache_fts MATCH ?
    ORDER BY url_cache_fts.rank
    LIMIT ?
  `).all(sanitizeFtsQuery(query), limit) as Array<{ url: string; rank: number }>;
  return rows.map(r => ({ url: r.url, score: -r.rank }));
}

export function clearCacheEntries(options: {
  query?: string;
  urlPattern?: string;
  since?: string;
}): number {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.query) {
    conditions.push(
      'id IN (SELECT url_cache.id FROM url_cache JOIN url_cache_fts ON url_cache.id = url_cache_fts.rowid WHERE url_cache_fts MATCH ?)',
    );
    params.push(sanitizeFtsQuery(options.query));
  }

  if (options.urlPattern) {
    conditions.push('normalized_url GLOB ?');
    params.push(options.urlPattern);
  }

  if (options.since) {
    conditions.push('fetched_at > datetime(?)');
    params.push(options.since);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `DELETE FROM url_cache ${whereClause}`;
  const result = db.prepare(sql).run(...params);
  return result.changes;
}

// Counts cached URLs for an exact host (apex scoping — `blog.example.com`
// and `example.com` are NOT collapsed). Leading `www.` is stripped to align
// with normalizeUrl.
export function countCachedUrlsForDomain(domain: string): number {
  const db = getDatabase();
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  const stmt = db.prepare(`
    SELECT COUNT(*) AS n FROM url_cache
    WHERE url LIKE 'http://' || ? || '/%'
       OR url LIKE 'https://' || ? || '/%'
       OR url LIKE 'http://www.' || ? || '/%'
       OR url LIKE 'https://www.' || ? || '/%'
       OR url = 'http://' || ?
       OR url = 'https://' || ?
       OR url = 'http://www.' || ?
       OR url = 'https://www.' || ?
  `);
  const row = stmt.get(
    normalized,
    normalized,
    normalized,
    normalized,
    normalized,
    normalized,
    normalized,
    normalized,
  ) as { n: number };
  return row.n;
}

export function getCacheStats(): CacheStats {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total_urls,
      COALESCE(SUM(LENGTH(markdown) + LENGTH(COALESCE(raw_html, ''))), 0) as total_bytes,
      MIN(fetched_at) as oldest,
      MAX(fetched_at) as newest
    FROM url_cache
  `).get() as { total_urls: number; total_bytes: number; oldest: string | null; newest: string | null };

  return {
    total_urls: row.total_urls,
    total_size_mb: Math.round((row.total_bytes / (1024 * 1024)) * 1e6) / 1e6,
    oldest: row.oldest ?? '',
    newest: row.newest ?? '',
  };
}

// --- Embedding store functions ---

export function updateCacheEmbedding(
  url: string,
  embedding: Buffer,
  model: string,
  dims: number,
): boolean {
  try {
    const db = getDatabase();
    let normalized: string;
    try {
      normalized = normalizeUrl(url);
    } catch {
      normalized = url;
    }

    const result = db.prepare(`
      UPDATE url_cache
      SET embedding = ?, embedding_model = ?, embedding_dims = ?, updated_at = datetime('now')
      WHERE normalized_url = ?
    `).run(embedding, model, dims, normalized);

    return result.changes > 0;
  } catch {
    return false;
  }
}

export interface EmbeddingData {
  embedding: Buffer;
  model: string;
  dims: number;
}

export function getEmbeddingForUrl(url: string, modelId?: string): EmbeddingData | null {
  try {
    const db = getDatabase();
    let normalized: string;
    try {
      normalized = normalizeUrl(url);
    } catch {
      normalized = url;
    }

    const row = db.prepare(`
      SELECT embedding, embedding_model, embedding_dims
      FROM url_cache
      WHERE (url = ? OR normalized_url = ?) AND embedding IS NOT NULL
      LIMIT 1
    `).get(url, normalized) as { embedding: Buffer; embedding_model: string; embedding_dims: number } | undefined;

    if (!row) return null;
    // Filter by modelId when caller wants only embeddings from the current
    // model; mismatched entries return null so they are treated as cache miss.
    if (modelId !== undefined && row.embedding_model !== modelId) return null;

    return {
      embedding: row.embedding,
      model: row.embedding_model,
      dims: row.embedding_dims,
    };
  } catch {
    return null;
  }
}

export interface StoredEmbedding {
  normalizedUrl: string;
  embedding: Buffer;
  model: string;
  dims: number;
}

// --- Domain routing (TLS-impersonation learning) ---

export interface DomainRoutingRow {
  domain: string;
  preferPlaywright: boolean;
  httpFailures: number;
  preferTlsImpersonation: boolean;
  tlsSuccessCount: number;
  lastUpdated?: string;
}

interface DomainRoutingRawRow {
  domain: string;
  prefer_playwright: number | null;
  http_failures: number | null;
  prefer_tls_impersonation: number | null;
  tls_success_count: number | null;
  last_updated: string | null;
}

export function getDomainRouting(domain: string): DomainRoutingRow | null {
  try {
    const db = getDatabase();
    const row = db.prepare(
      `SELECT domain, prefer_playwright, http_failures,
              prefer_tls_impersonation, tls_success_count, last_updated
       FROM domain_routing WHERE domain = ? LIMIT 1`,
    ).get(domain) as DomainRoutingRawRow | undefined;
    if (!row) return null;
    return {
      domain: row.domain,
      preferPlaywright: (row.prefer_playwright ?? 0) === 1,
      httpFailures: row.http_failures ?? 0,
      preferTlsImpersonation: (row.prefer_tls_impersonation ?? 0) === 1,
      tlsSuccessCount: row.tls_success_count ?? 0,
      lastUpdated: row.last_updated ?? undefined,
    };
  } catch (err) {
    log.warn('getDomainRouting failed', { domain, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Record a successful TLS-impersonation fetch for the domain and flip the
 * `prefer_tls_impersonation` bit once `tls_success_count` reaches `threshold`.
 * Atomic so concurrent callers can't double-count.
 */
export function recordTlsImpersonationSuccess(domain: string, threshold: number): DomainRoutingRow | null {
  try {
    const db = getDatabase();
    // The INSERT path sets prefer_tls_impersonation=1 when the threshold
    // is <=1 (rare; only used in tests/aggressive opt-in). The ON CONFLICT
    // UPDATE path computes the flip atomically against the post-increment
    // count to avoid a read-modify-write race between concurrent requests
    // for the same domain.
    const preferOnInsert = threshold <= 1 ? 1 : 0;
    db.prepare(`
      INSERT INTO domain_routing (
        domain, prefer_playwright, http_failures,
        prefer_tls_impersonation, tls_success_count, last_updated
      )
      VALUES (?, 0, 0, ?, 1, datetime('now'))
      ON CONFLICT(domain) DO UPDATE SET
        tls_success_count = tls_success_count + 1,
        last_updated = datetime('now'),
        prefer_tls_impersonation = CASE
          WHEN tls_success_count + 1 >= ?
          THEN 1
          ELSE prefer_tls_impersonation
        END
    `).run(domain, preferOnInsert, threshold);
    return getDomainRouting(domain);
  } catch (err) {
    log.warn('recordTlsImpersonationSuccess failed', {
      domain,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface DomainClearance {
  cookie: string;
  ua: string;
  tier: string;
  expiresAt: string;
}

interface DomainClearanceRawRow {
  cf_clearance: string | null;
  clearance_ua: string | null;
  clearance_tier: string | null;
  clearance_expires_at: string | null;
}

/**
 * Read the stored anti-bot clearance for a host. Keyed on the RAW hostname
 * (the same key domain_routing uses) so `a.example.com` and `b.example.com`
 * keep independent clearances. Returns null when no clearance cookie is
 * recorded. Freshness is the caller's decision — an expired entry is still
 * returned so callers can inspect `expiresAt`.
 */
export function getDomainClearance(host: string): DomainClearance | null {
  try {
    const db = getDatabase();
    const row = db.prepare(
      `SELECT cf_clearance, clearance_ua, clearance_tier, clearance_expires_at
       FROM domain_routing WHERE domain = ? LIMIT 1`,
    ).get(host) as DomainClearanceRawRow | undefined;
    if (!row || row.cf_clearance == null) return null;
    return {
      cookie: row.cf_clearance,
      ua: row.clearance_ua ?? '',
      tier: row.clearance_tier ?? '',
      expiresAt: row.clearance_expires_at ?? '',
    };
  } catch (err) {
    log.warn('getDomainClearance failed', { host, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Store (or replace) the anti-bot clearance for a host. */
export function recordDomainClearance(host: string, clearance: DomainClearance): void {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO domain_routing (
        domain, prefer_playwright, http_failures,
        cf_clearance, clearance_ua, clearance_tier, clearance_expires_at, last_updated
      )
      VALUES (?, 0, 0, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(domain) DO UPDATE SET
        cf_clearance = excluded.cf_clearance,
        clearance_ua = excluded.clearance_ua,
        clearance_tier = excluded.clearance_tier,
        clearance_expires_at = excluded.clearance_expires_at,
        last_updated = datetime('now')
    `).run(host, clearance.cookie, clearance.ua, clearance.tier, clearance.expiresAt);
  } catch (err) {
    log.warn('recordDomainClearance failed', { host, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Wipe the clearance fields for a host (routing row itself is retained). */
export function clearDomainClearance(host: string): void {
  try {
    const db = getDatabase();
    db.prepare(`
      UPDATE domain_routing
      SET cf_clearance = NULL, clearance_ua = NULL,
          clearance_tier = NULL, clearance_expires_at = NULL,
          last_updated = datetime('now')
      WHERE domain = ?
    `).run(host);
  } catch (err) {
    log.warn('clearDomainClearance failed', { host, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Record a per-host cooldown (epoch ms) after repeated blocks. */
export function recordBackoff(host: string, untilEpochMs: number): void {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO domain_routing (
        domain, prefer_playwright, http_failures, backoff_until, last_403_at, last_updated
      )
      VALUES (?, 0, 0, ?, datetime('now'), datetime('now'))
      ON CONFLICT(domain) DO UPDATE SET
        backoff_until = excluded.backoff_until,
        last_403_at = datetime('now'),
        last_updated = datetime('now')
    `).run(host, String(untilEpochMs));
  } catch (err) {
    log.warn('recordBackoff failed', { host, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Read the per-host cooldown (epoch ms), or null when none is set. */
export function getBackoff(host: string): number | null {
  try {
    const db = getDatabase();
    const row = db.prepare(
      'SELECT backoff_until FROM domain_routing WHERE domain = ? LIMIT 1',
    ).get(host) as { backoff_until: string | null } | undefined;
    if (!row || row.backoff_until == null) return null;
    const parsed = Number(row.backoff_until);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (err) {
    log.warn('getBackoff failed', { host, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Read-only projection of a domain_routing row for the `wigolo tune` surface.
 *
 * Deliberately OMITS the live clearance cookie value (`cf_clearance`) and the
 * user-agent it was minted against (`clearance_ua`): both are session-bearing
 * credentials that must never surface in an inspection command. Only the
 * PRESENCE of a clearance and its expiry are reported.
 */
export interface DomainRoutingSummary {
  domain: string;
  /** Whether wigolo prefers the browser engine for this domain. */
  preferBrowser: boolean;
  preferTlsImpersonation: boolean;
  tlsSuccessCount: number;
  httpFailures: number;
  backoffUntil?: string;
  last403At?: string;
  clearancePresent: boolean;
  clearanceExpiresAt?: string;
}

interface DomainRoutingSummaryRawRow {
  domain: string;
  prefer_playwright: number | null;
  prefer_tls_impersonation: number | null;
  tls_success_count: number | null;
  http_failures: number | null;
  backoff_until: string | null;
  last_403_at: string | null;
  cf_clearance: string | null;
  clearance_expires_at: string | null;
}

/**
 * Every tracked domain's routing summary, ordered by domain. Follows the
 * read-swallow convention of the other routing getters: a DB read failure
 * degrades to an empty list rather than crashing an inspection command.
 */
export function listDomainRouting(): DomainRoutingSummary[] {
  try {
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT domain, prefer_playwright, prefer_tls_impersonation, tls_success_count,
              http_failures, backoff_until, last_403_at, cf_clearance, clearance_expires_at
       FROM domain_routing
       ORDER BY domain`,
    ).all() as DomainRoutingSummaryRawRow[];
    return rows.map((row) => ({
      domain: row.domain,
      preferBrowser: (row.prefer_playwright ?? 0) === 1,
      preferTlsImpersonation: (row.prefer_tls_impersonation ?? 0) === 1,
      tlsSuccessCount: row.tls_success_count ?? 0,
      httpFailures: row.http_failures ?? 0,
      backoffUntil: row.backoff_until ?? undefined,
      last403At: row.last_403_at ?? undefined,
      clearancePresent: row.cf_clearance != null,
      clearanceExpiresAt: row.clearance_expires_at ?? undefined,
    }));
  } catch (err) {
    log.warn('listDomainRouting failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

const RESET_ROUTING_COLUMNS = `
  prefer_playwright = 0,
  prefer_tls_impersonation = 0,
  tls_success_count = 0,
  http_failures = 0,
  backoff_until = NULL,
  last_403_at = NULL,
  cf_clearance = NULL,
  clearance_ua = NULL,
  clearance_tier = NULL,
  clearance_expires_at = NULL,
  last_updated = datetime('now')
`;

/**
 * Clear all learned routing prefs, backoff windows and clearance state for one
 * host, returning the number of rows changed (0 when the host is unknown).
 * Intentionally does NOT swallow errors — a busy/locked DB must surface to the
 * caller so the CLI can report it, rather than silently leaving stale routing.
 */
export function resetDomainRouting(host: string): number {
  const db = getDatabase();
  const info = db.prepare(
    `UPDATE domain_routing SET ${RESET_ROUTING_COLUMNS} WHERE domain = ?`,
  ).run(host);
  return info.changes;
}

/**
 * Clear learned routing state for EVERY tracked host, returning the total rows
 * changed. Like {@link resetDomainRouting}, throws on failure.
 */
export function resetAllDomainRouting(): number {
  const db = getDatabase();
  const info = db.prepare(
    `UPDATE domain_routing SET ${RESET_ROUTING_COLUMNS}`,
  ).run();
  return info.changes;
}

export function getAllEmbeddings(modelId?: string): StoredEmbedding[] {
  try {
    const db = getDatabase();
    // Filter by modelId when provided so stale entries from a previous model
    // (different dim / vector space) are skipped — the in-memory vector index
    // requires matching dimensionality across all entries.
    const rows = modelId !== undefined
      ? db.prepare(`
          SELECT normalized_url, embedding, embedding_model, embedding_dims
          FROM url_cache
          WHERE embedding IS NOT NULL AND embedding_model = ?
        `).all(modelId) as Array<{
          normalized_url: string;
          embedding: Buffer;
          embedding_model: string;
          embedding_dims: number;
        }>
      : db.prepare(`
          SELECT normalized_url, embedding, embedding_model, embedding_dims
          FROM url_cache
          WHERE embedding IS NOT NULL
        `).all() as Array<{
          normalized_url: string;
          embedding: Buffer;
          embedding_model: string;
          embedding_dims: number;
        }>;

    return rows.map(r => ({
      normalizedUrl: r.normalized_url,
      embedding: r.embedding,
      model: r.embedding_model,
      dims: r.embedding_dims,
    }));
  } catch {
    return [];
  }
}
