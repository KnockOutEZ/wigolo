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
  /**
   * K9. Whether THIS BODY was fetched with authenticated session material applied.
   *
   * Per-body rather than per-URL, and that is the point: `url_cache` holds one row per URL and replaces
   * it, so a page re-fetched anonymously loses the authenticated label there. The body that WAS
   * authenticated keeps its own row here, still marked — history stays labelled while the current row
   * tells the truth about what it contains.
   *
   * The column shipped with `013-url-versions` and had **no writer** until now, which is the
   * declared-with-no-producer shape this codebase has had to correct before.
   */
  originAuthenticated: boolean;
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

  // 3. Total bytes — global, because disk is a single shared resource.
  //
  //    Short-circuited on a plain SUM first. The sweep below builds a windowed
  //    running total over the whole table, and it runs on the fetch path every
  //    time a page's content changes: a crawl of N changed pages would pay N
  //    sweeps of a table that only exceeds its budget once. The SUM is served by
  //    idx_url_versions_time, which carries byte_len for exactly this reason, so
  //    the common case never builds the window at all.
  const total = db.prepare('SELECT COALESCE(SUM(byte_len), 0) AS total FROM url_versions').get() as {
    total: number;
  };
  if (total.total <= bounds.maxBytes) return;

  //    A row is kept only while the running total INCLUDING it, taken
  //    newest-first, stays within budget. What this bounds is the RETAINED set,
  //    not the database file: a row deleted here was still written first, and
  //    db.ts sets no auto_vacuum, so its pages stay allocated to the file after
  //    the delete. Oversized versions are therefore refused BEFORE the insert
  //    (see recordVersion) rather than swept out afterwards — by the time a body
  //    reaches this sweep, keeping the file's high-water mark down is no longer
  //    possible.
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

    // A version that alone exceeds the whole byte budget can never be retained,
    // so refuse it before it is ever written rather than sweeping it out after.
    //
    // On disk that is the only way to bound anything: an inserted-then-deleted
    // body still went through the WAL into the main file, and db.ts sets no
    // auto_vacuum, so those pages are never returned to the OS. One very large
    // extraction would otherwise raise the file's high-water mark permanently
    // while SUM(byte_len) went on reading zero.
    //
    // It is also not merely a disk optimisation, which is why it has its own
    // test: letting the body land would push the table over budget and fire the
    // global sweep, whose newest-first accounting would spend the entire budget
    // on the oversized row and evict unrelated URLs' versions as collateral.
    if (byteLen > bounds.maxBytes) return;

    db.transaction(() => {
      if (newestHash(db, record.normalizedUrl) === record.contentHash) return;

      // INSERT OR REPLACE, not plain INSERT: (normalized_url, content_hash) is
      // unique, so a page reverting to a body it served before would otherwise
      // throw. Replacing re-times that body to when it was last observed, which
      // is the answer a point-in-time read needs; the cost is that the earlier
      // occurrence's timestamp is not kept.
      db.prepare(
        `INSERT OR REPLACE INTO url_versions (
           normalized_url, content_hash, markdown, title, http_status, fetched_at, byte_len,
           origin_authenticated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.normalizedUrl,
        record.contentHash,
        record.markdown,
        record.title,
        record.httpStatus,
        record.fetchedAt,
        byteLen,
        record.originAuthenticated ? 1 : 0,
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
 * Ids bound per DELETE. SQLite refuses a statement past 32766 parameters
 * (measured on this repo's better-sqlite3: 32766 binds, 32767 throws
 * `too many SQL variables`), and `clearCacheEntries` builds its id set from BOTH
 * `url` and `normalized_url`, so it reaches that ceiling at ~16k cached rows.
 * 900 leaves room under even the old 999-parameter default without making the
 * statement count meaningful.
 */
const DELETE_CHUNK_SIZE = 900;

/**
 * Drop every retained version for these normalized URLs.
 *
 * Called from `clearCacheEntries`. Without it, a user's explicit "clear this
 * from my machine" would leave full page bodies behind in a table they were
 * never told about — the same class of defect as clearing a row while leaving
 * its vector searchable.
 *
 * Chunked because the caller runs this INSIDE the transaction that already
 * deleted from `url_cache`: a `too many SQL variables` throw here would roll
 * that delete back too, turning a bulk clear into a silent no-op that leaves
 * cache rows, vectors and versions all on disk.
 *
 * The sibling `deleteVectorsByExternalId` stays under the same ceiling by
 * looping one id at a time, and that shape is load-bearing THERE for a reason
 * that does not apply here: each id must first be resolved to a rowid, then fed
 * to three dependent statements, so it could not be expressed as a set delete
 * at any batch size. This is a single membership test on an indexed column, so
 * batching does the same job in ~40 statements instead of ~33,000.
 */
export function deleteVersionsForUrls(db: Database.Database, normalizedUrls: string[]): number {
  if (normalizedUrls.length === 0) return 0;
  let removed = 0;
  for (let start = 0; start < normalizedUrls.length; start += DELETE_CHUNK_SIZE) {
    const chunk = normalizedUrls.slice(start, start + DELETE_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    removed += db
      .prepare(`DELETE FROM url_versions WHERE normalized_url IN (${placeholders})`)
      .run(...chunk).changes;
  }
  return removed;
}
