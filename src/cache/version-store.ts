import type Database from 'better-sqlite3';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('cache');

export interface VersionRecord {
  normalizedUrl: string;
  contentHash: string;
  markdown: string;
  title: string | null;
  httpStatus: number | null;
  /** Zone-less UTC "YYYY-MM-DD HH:MM:SS", the same shape url_cache.fetched_at uses. */
  fetchedAt: string;
}

interface RetentionBounds {
  maxVersionsPerUrl: number;
  maxBytes: number;
  maxAgeDays: number;
}

/**
 * Resolve the three retention bounds. Any bound at or below zero DISABLES the
 * time axis for new writes — it does not purge what is already stored. That
 * asymmetry is the point: a user turning the feature off is saying "stop
 * recording", not "destroy my history", and the two are different consents.
 */
function resolveBounds(): RetentionBounds {
  const config = getConfig();
  return {
    maxVersionsPerUrl: config.corpusMaxVersionsPerUrl,
    maxBytes: config.corpusMaxVersionBytes,
    maxAgeDays: config.corpusVersionMaxAgeDays,
  };
}

function isDisabled(bounds: RetentionBounds): boolean {
  return bounds.maxVersionsPerUrl <= 0 || bounds.maxBytes <= 0 || bounds.maxAgeDays <= 0;
}

/**
 * The hash of the most recent retained version for this URL, or null when the
 * URL has no history yet.
 *
 * Deliberately keyed on the NEWEST retained row rather than on "any row with
 * this hash": a page that returns to a body it once had is a change from where
 * it currently stands, and the read surface must be able to say so.
 */
function newestHash(db: Database.Database, normalizedUrl: string): string | null {
  const row = db
    .prepare(
      `SELECT content_hash FROM url_versions
       WHERE normalized_url = ?
       ORDER BY fetched_at DESC, id DESC
       LIMIT 1`,
    )
    .get(normalizedUrl) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

/**
 * Evict oldest-first until all three bounds hold. Runs inside the caller's
 * transaction so no observer can ever see the table above a bound — G-S14-1b
 * asserts the byte ceiling after EVERY write, not only at the end of a run.
 */
function evict(db: Database.Database, normalizedUrl: string, bounds: RetentionBounds): void {
  // 1. Age — global, and cheapest first because it frees rows the other two
  //    bounds would otherwise have to account for.
  db.prepare(`DELETE FROM url_versions WHERE fetched_at < datetime('now', ?)`).run(
    `-${bounds.maxAgeDays} days`,
  );

  // 2. Per-URL count. Per URL, not table-wide: this write only grew one URL's
  //    history, and a global row cap would let a busy URL evict a quiet one's
  //    only version.
  db.prepare(
    `DELETE FROM url_versions
     WHERE normalized_url = ?
       AND id NOT IN (
         SELECT id FROM url_versions
         WHERE normalized_url = ?
         ORDER BY fetched_at DESC, id DESC
         LIMIT ?
       )`,
  ).run(normalizedUrl, normalizedUrl, bounds.maxVersionsPerUrl);

  // 3. Total bytes — global, because disk is a single shared resource. The
  //    running sum is taken newest-first and a row is kept only while the
  //    cumulative total INCLUDING it stays within budget. That also settles the
  //    degenerate case a per-row guard would miss: a single version larger than
  //    the whole budget is retained by nothing, so the ceiling cannot be
  //    breached by one oversized page.
  db.prepare(
    `DELETE FROM url_versions
     WHERE id NOT IN (
       SELECT id FROM (
         SELECT id, SUM(byte_len) OVER (ORDER BY fetched_at DESC, id DESC) AS running
         FROM url_versions
       )
       WHERE running <= ?
     )`,
  ).run(bounds.maxBytes);
}

/**
 * Append a version of this URL's body, but only when the content differs from
 * the newest version already retained for it.
 *
 * Why append-on-change and not on every fetch: a page fetched 200 times
 * unchanged must cost one row, and the dedup key makes that structural rather
 * than a caller's discipline (D-S14-1).
 *
 * Never throws. A failure to record history must not fail the `url_cache` write
 * it rides along with — the current page is the hot path and S14-1's contract is
 * that it is unchanged.
 */
export function recordVersion(db: Database.Database, record: VersionRecord): void {
  try {
    const bounds = resolveBounds();
    if (isDisabled(bounds)) return;

    const byteLen = Buffer.byteLength(record.markdown, 'utf8');

    db.transaction(() => {
      if (newestHash(db, record.normalizedUrl) === record.contentHash) return;

      // INSERT OR REPLACE, not plain INSERT: (normalized_url, content_hash) is
      // unique, so a page reverting to a body it served before would otherwise
      // throw. Replacing re-times that body to when it was last observed, which
      // is the answer a point-in-time read needs; the cost is that the earlier
      // occurrence's timestamp is not kept.
      db.prepare(
        `INSERT OR REPLACE INTO url_versions (
           normalized_url, content_hash, markdown, title, http_status, fetched_at, byte_len
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.normalizedUrl,
        record.contentHash,
        record.markdown,
        record.title,
        record.httpStatus,
        record.fetchedAt,
        byteLen,
      );

      evict(db, record.normalizedUrl, bounds);
    })();
  } catch (err) {
    log.warn('recordVersion failed', {
      url: record.normalizedUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Drop every retained version for these normalized URLs.
 *
 * Called from `clearCacheEntries`. Without it, a user's explicit "clear this
 * from my machine" would leave full page bodies behind in a table they were
 * never told about — the same class of defect as clearing a row while leaving
 * its vector searchable.
 */
export function deleteVersionsForUrls(db: Database.Database, normalizedUrls: string[]): number {
  if (normalizedUrls.length === 0) return 0;
  const placeholders = normalizedUrls.map(() => '?').join(',');
  const result = db
    .prepare(`DELETE FROM url_versions WHERE normalized_url IN (${placeholders})`)
    .run(...normalizedUrls);
  return result.changes;
}
