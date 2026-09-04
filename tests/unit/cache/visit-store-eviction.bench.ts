import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDatabase, getDatabase, initDatabase } from '../../../src/cache/db.js';
import { recordVisit, VISIT_RETENTION_DEFAULTS } from '../../../src/cache/visit-store.js';

const VISITS = 30_000;
const BODY_BYTES = 10 * 1024;
const WARMUPS = 5;
const SAMPLES = 20;
const WARM_P95_LIMIT_MS = 5;

const dir = mkdtempSync(join(tmpdir(), 'wigolo-visit-eviction-bench-'));
const dbPath = join(dir, 'cache.db');

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

  const samples: number[] = [];
  for (let i = 0; i < WARMUPS + SAMPLES; i += 1) {
    const started = performance.now();
    const result = recordVisit({
      url: `https://bench.invalid/measured/${i}`,
      title: `Measured ${i}`,
      ts,
      tabId: 'bench-tab',
      markdown: `measured body ${i}`,
      retention: VISIT_RETENTION_DEFAULTS,
    });
    const elapsed = performance.now() - started;
    if (!result.stored) throw new Error(`recordVisit failed during sample ${i}`);
    if (i >= WARMUPS) samples.push(elapsed);
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const totalBytes = (
    db.prepare('SELECT COALESCE(SUM(byte_len), 0) AS total FROM studio_visit_pages').get() as { total: number }
  ).total;
  const plan = (
    db.prepare('EXPLAIN QUERY PLAN SELECT COALESCE(SUM(byte_len), 0) FROM studio_visit_pages').all() as Array<{
      detail: string;
    }>
  ).map((step) => step.detail).join(' | ');

  process.stdout.write(
    `fixture=${VISITS} visits/${(totalBytes / (1024 * 1024)).toFixed(1)} MiB ` +
      `recordVisit warm p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms\n` +
      `sum-plan=${plan}\n`,
  );
  if (p95 >= WARM_P95_LIMIT_MS) {
    throw new Error(`recordVisit warm p95 ${p95.toFixed(3)}ms exceeds ${WARM_P95_LIMIT_MS}ms`);
  }
} finally {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
}
