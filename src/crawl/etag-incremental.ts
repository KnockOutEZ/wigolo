import { getDatabase } from '../cache/db.js';
import { createLogger } from '../logger.js';
import type { RawFetchResult } from '../types.js';

const log = createLogger('crawl');

export interface CachedFetchHeaders {
  etag?: string;
  lastModified?: string;
  fetchedAt: string;
}

/**
 * Look up cached ETag + Last-Modified for a URL. Returns null when no row
 * exists (first crawl, or table missing).
 */
export function getCachedHeaders(url: string): CachedFetchHeaders | null {
  try {
    const db = getDatabase();
    const row = db.prepare(
      'SELECT etag, last_modified, fetched_at FROM crawl_etags WHERE url = ?',
    ).get(url) as { etag: string | null; last_modified: string | null; fetched_at: string } | undefined;
    if (!row) return null;
    const out: CachedFetchHeaders = { fetchedAt: row.fetched_at };
    if (row.etag) out.etag = row.etag;
    if (row.last_modified) out.lastModified = row.last_modified;
    return out;
  } catch (err) {
    log.debug('getCachedHeaders failed', { url, error: String(err) });
    return null;
  }
}

/**
 * Persist ETag + Last-Modified from a fresh fetch. Headers are looked up
 * case-insensitively so both `ETag` and `etag` are accepted.
 */
export function saveFetchHeaders(url: string, headers: Record<string, string>): void {
  try {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const etag = lower['etag'] ?? null;
    const lastModified = lower['last-modified'] ?? null;
    const origin = new URL(url).origin;
    const fetchedAt = new Date().toISOString();

    const db = getDatabase();
    db.prepare(`
      INSERT INTO crawl_etags (url, origin, etag, last_modified, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        origin = excluded.origin,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        fetched_at = excluded.fetched_at
    `).run(url, origin, etag, lastModified, fetchedAt);
  } catch (err) {
    log.debug('saveFetchHeaders failed', { url, error: String(err) });
  }
}

/**
 * Update only fetched_at on the existing row (no header change).
 */
export function markFetchedNotModified(url: string): void {
  try {
    const db = getDatabase();
    db.prepare('UPDATE crawl_etags SET fetched_at = ? WHERE url = ?')
      .run(new Date().toISOString(), url);
  } catch (err) {
    log.debug('markFetchedNotModified failed', { url, error: String(err) });
  }
}

/**
 * Conditional-fetch wrapper. SmartRouter's RawFetchFn signature is
 * `(url) => Promise<RawFetchResult>` and we deliberately do not extend it
 * here (Phase 11 contract). Because we cannot inject If-None-Match, this
 * wrapper does a full GET every time but compares the response's ETag /
 * Last-Modified against the cached values. When unchanged we surface
 * `notModified: true` so the caller can skip downstream work (dedup,
 * embedding, etc).
 *
 * Network is NOT saved — true 304 handling requires a SmartRouter change
 * tracked in DEFERRED.md.
 */
export async function conditionalFetch(
  url: string,
  rawFetchFn: (url: string) => Promise<RawFetchResult>,
): Promise<RawFetchResult & { notModified?: boolean }> {
  const cached = getCachedHeaders(url);
  const result = await rawFetchFn(url);

  const respHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(result.headers ?? {})) respHeaders[k.toLowerCase()] = v;
  const respEtag = respHeaders['etag'];
  const respLastModified = respHeaders['last-modified'];

  let notModified = false;
  if (cached) {
    if (cached.etag && respEtag && cached.etag === respEtag) notModified = true;
    else if (
      !respEtag &&
      cached.lastModified &&
      respLastModified &&
      cached.lastModified === respLastModified
    ) notModified = true;
  }

  if (respEtag || respLastModified) {
    saveFetchHeaders(url, result.headers ?? {});
  } else if (cached) {
    markFetchedNotModified(url);
  } else {
    // No cached row + no etag headers; still record fetched_at so the
    // origin index gets populated for future probes.
    saveFetchHeaders(url, result.headers ?? {});
  }

  if (notModified) return { ...result, notModified };
  return result;
}

/**
 * Test helper: wipe the crawl_etags table. Safe to call when the DB is
 * uninitialised — it just no-ops.
 */
export function _clearEtagCacheForTest(): void {
  try {
    const db = getDatabase();
    db.exec('DELETE FROM crawl_etags');
  } catch {
    // DB not initialised — nothing to clear
  }
}
