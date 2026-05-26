import { createHash } from 'node:crypto';
import { getDatabase } from './db.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { RawFetchResult, ExtractionResult, CachedContent, SearchResultItem, CacheStats } from '../types.js';

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

export function cacheContent(result: RawFetchResult, extraction: ExtractionResult): void {
  try {
    const db = getDatabase();
    const config = getConfig();

    const normalizedUrl = normalizeUrl(result.finalUrl || result.url);
    const contentHash = createHash('sha256').update(extraction.markdown).digest('hex');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.cacheTtlContent * 1000);

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO url_cache (
        url, normalized_url, title, markdown, raw_html,
        metadata, links, images, fetch_method, extractor_used,
        content_hash, fetched_at, expires_at, http_status
      )
      VALUES (
        @url, @normalizedUrl, @title, @markdown, @rawHtml,
        @metadata, @links, @images, @fetchMethod, @extractorUsed,
        @contentHash, @fetchedAt, @expiresAt, @httpStatus
      )
    `);

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
      // Slice S1 (C2): persist upstream status so cache lookups can branch
      // on 200 vs 404 vs 5xx instead of trusting body-hash alone.
      httpStatus: typeof result.statusCode === 'number' ? result.statusCode : null,
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
  // Slice S1 (C2): nullable so legacy rows from before the column existed
  // still hydrate cleanly. Migration 006 adds the column without a default.
  http_status: number | null;
}

function rowToCachedContent(row: DbRow): CachedContent {
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
 * Slice S1 (C2): cached HTTP status for change-detection. Returns `null`
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
 * Slice S1 follow-up: read content_hash and http_status in a single
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
  return new Date(cached.expiresAt).getTime() < Date.now();
}

export interface CacheLookupOptions {
  staleMaxSeconds?: number;
}

export function isCacheUsable(
  cached: CachedContent,
  opts: CacheLookupOptions = {},
): { usable: boolean; stale: boolean } {
  if (!cached.expiresAt) return { usable: true, stale: false };
  const expiresMs = new Date(cached.expiresAt).getTime();
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
    filters.exact_match != null
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
    const expiresMs = new Date(row.expires_at).getTime();
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

// --- Embedding store functions (Slice 22) ---

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

// --- Domain routing (Slice D2: TLS-impersonation learning) ---

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
