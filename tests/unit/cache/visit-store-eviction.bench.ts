import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDatabase, getDatabase, initDatabase } from '../../../src/cache/db.js';
import { recordVisit, VISIT_RETENTION_DEFAULTS } from '../../../src/cache/visit-store.js';
import type { VisitRetentionBounds } from '../../../src/cache/visit-store.js';

/**
 * The per-visit cost of retention, measured on a store big enough for a bound to be able to
 * bind. `recordVisit` runs on every navigation settle, so an eviction arm that is O(rows) is
 * O(rows) work in the DB child between the user and their next page.
 *
 * Two arms are measured because there are two ways to be wrong here, and #407 only pinned
 * the first:
 *
 * - BELOW every bound, the arms must not run at all. A sweep that deletes nothing has still
 *   walked the index to find that out (#478: the row cap's `LIMIT -1 OFFSET` traversed
 *   min(rows, cap) entries on every single navigation).
 * - AT a bound, the arm must cost what it deleted and not what is stored. The predecessor's
 *   orphan sweep asked a global `NOT IN` over every visit hash and then passed over every
 *   body — ~35 ms per eviction at this fixture size — to drop the one body it had orphaned.
 */

const VISITS = 30_000;
const BODY_BYTES = 10 * 1024;
const WARMUPS = 5;
const SAMPLES = 20;
const WARM_P95_LIMIT_MS = 5;

const dir = mkdtempSync(join(tmpdir(), 'wigolo-visit-eviction-bench-'));
const dbPath = join(dir, 'cache.db');

function planOf(db: ReturnType<typeof getDatabase>, sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((step) => step.detail)
    .join(' | ');
}

try {
  const db = initDatabase(dbPath);
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const insertPage = db.prepare(
    `INSERT INTO studio_visit_pages (content_hash, markdown, byte_len, created_at)
     VALUES (?, CAST(zeroblob(?) AS TEXT), ?, ?)`,
  );
  const insertVisit = db.prepare(
    `INSERT INTO studio_visits (url, normalized_url, title, ts, tab_id, space_id, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (let i = 0; i < VISITS; i += 1) {
      const hash = i.toString(16).padStart(64, '0');
      const url = `https://bench.invalid/page/${i}`;
      insertPage.run(hash, BODY_BYTES, BODY_BYTES, ts);
      insertVisit.run(url, url, `Page ${i}`, ts, 'bench-tab', 'default', hash);
    }
  })();

  /** Warm p95 of `recordVisit` under `bounds`, with the samples' warmups discarded. */
  function measure(label: string, bounds: VisitRetentionBounds): number {
    const samples: number[] = [];
    for (let i = 0; i < WARMUPS + SAMPLES; i += 1) {
      const started = performance.now();
      const result = recordVisit({
        url: `https://bench.invalid/${label}/${i}`,
        title: `Measured ${i}`,
        ts,
        tabId: 'bench-tab',
        markdown: `measured ${label} body ${i}`,
        retention: bounds,
      });
      const elapsed = performance.now() - started;
      if (!result.stored) throw new Error(`recordVisit failed during ${label} sample ${i}`);
      if (i >= WARMUPS) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    process.stdout.write(`${label.padEnd(10)} recordVisit warm p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms\n`);
    return p95;
  }

  // Arm 1 — every bound idle. Nothing is deleted, so nothing may be walked either.
  const idleP95 = measure('below-cap', VISIT_RETENTION_DEFAULTS);

  // Arm 2 — the row cap held at the fixture size, so every measured write evicts exactly one
  // visit and orphans exactly one body. The cost must track that one row, not the 30k stored.
  const rowCount = (db.prepare('SELECT COUNT(*) AS n FROM studio_visits').get() as { n: number }).n;
  const atCapP95 = measure('at-cap', { ...VISIT_RETENTION_DEFAULTS, maxVisits: rowCount });
  const afterCap = (db.prepare('SELECT COUNT(*) AS n FROM studio_visits').get() as { n: number }).n;
  if (afterCap > rowCount) throw new Error(`row cap did not bind: ${afterCap} rows above cap ${rowCount}`);

  const totalBytes = (
    db.prepare('SELECT COALESCE(SUM(byte_len), 0) AS total FROM studio_visit_pages').get() as { total: number }
  ).total;

  process.stdout.write(
    `fixture=${VISITS} visits/${(totalBytes / (1024 * 1024)).toFixed(1)} MiB\n` +
      `sum-plan=${planOf(db, 'SELECT COALESCE(SUM(byte_len), 0) FROM studio_visit_pages')}\n` +
      `span-plan=${planOf(db, 'SELECT MIN(id) AS v FROM studio_visits')}\n`,
  );

  for (const [label, p95] of [
    ['below-cap', idleP95],
    ['at-cap', atCapP95],
  ] as const) {
    if (p95 >= WARM_P95_LIMIT_MS) {
      throw new Error(`recordVisit ${label} warm p95 ${p95.toFixed(3)}ms exceeds ${WARM_P95_LIMIT_MS}ms`);
    }
  }
} finally {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
}
