import { createHash } from 'node:crypto';
import { getDatabase } from './db.js';
import { getConfig } from '../config.js';
import type { RawFetchResult, ExtractionResult, CachedContent, SearchResultItem } from '../types.js';

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
      content_hash, fetched_at, expires_at
    )
    VALUES (
      @url, @normalizedUrl, @title, @markdown, @rawHtml,
      @metadata, @links, @images, @fetchMethod, @extractorUsed,
      @contentHash, @fetchedAt, @expiresAt
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
  });
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

export function isExpired(cached: CachedContent): boolean {
  if (!cached.expiresAt) return false;
  return new Date(cached.expiresAt).getTime() < Date.now();
}

export function searchCache(query: string): CachedContent[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT url_cache.*
    FROM url_cache
    JOIN url_cache_fts ON url_cache.id = url_cache_fts.rowid
    WHERE url_cache_fts MATCH ?
    ORDER BY rank
  `).all(query) as DbRow[];

  return rows.map(rowToCachedContent);
}

export interface CachedSearchResult {
  query: string;
  results: SearchResultItem[];
  engines_used: string[];
  searched_at: string;
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

export function getCachedSearchResults(query: string): CachedSearchResult | null {
  const db = getDatabase();
  const queryHash = createHash('sha256').update(query.toLowerCase().trim()).digest('hex');

  const row = db.prepare(`
    SELECT * FROM search_cache WHERE query_hash = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(queryHash) as { query: string; results: string; engines_used: string; searched_at: string } | undefined;

  if (!row) return null;

  return {
    query: row.query,
    results: JSON.parse(row.results),
    engines_used: JSON.parse(row.engines_used),
    searched_at: row.searched_at,
  };
}
