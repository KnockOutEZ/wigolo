#!/usr/bin/env node
/**
 * Re-derive the `cache` tool's output budgets from a real cache.
 *
 *   npm run build && node scripts/derive-cache-budget.mjs [path/to/wigolo.db]
 *
 * (the build is for the token counter it imports from dist/)
 *
 * Prints the page-size distribution, what fraction of default-limit responses
 * each candidate budget would leave untouched, and the check_changes row cap
 * that fits the chosen budget. The constants in src/cache/output-budget.ts cite
 * this script's output; run it against your own cache to check them.
 *
 * Read-only: opens the database readonly and never writes.
 */
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { countTokens } from '../dist/search/tokens.js';

const DEFAULT_ROW_LIMIT = 5; // DEFAULT_CACHE_QUERY_LIMIT
const CANDIDATES = [4000, 8000, 12000, 16000, 20000, 40000];
const DRAWS = 20000;

const dbPath = process.argv[2] ?? join(homedir(), '.wigolo', 'wigolo.db');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const pages = db
  .prepare('SELECT markdown, url, content_hash FROM url_cache')
  .all()
  .map((r) => ({
    tokens: countTokens(r.markdown ?? ''),
    chars: (r.markdown ?? '').length,
    url: r.url,
    hash: r.content_hash,
  }));

if (pages.length === 0) {
  console.error(`No cached pages in ${dbPath} — nothing to derive from.`);
  process.exit(1);
}

const sorted = pages.map((p) => p.tokens).sort((a, b) => a - b);
const pct = (arr, p) => arr[Math.floor((arr.length - 1) * p)];

console.log(`corpus: ${dbPath}`);
console.log(`pages=${pages.length} chars=${pages.reduce((n, p) => n + p.chars, 0)}`);
console.log(
  `page tokens: p50=${pct(sorted, 0.5)} p75=${pct(sorted, 0.75)} ` +
  `p90=${pct(sorted, 0.9)} p99=${pct(sorted, 0.99)} max=${sorted[sorted.length - 1]}`,
);

// A default-limit response is DEFAULT_ROW_LIMIT pages. Sample the sum rather
// than multiplying the median — page sizes are heavily skewed, so 5x the median
// badly understates the typical response.
const sums = [];
for (let i = 0; i < DRAWS; i++) {
  let s = 0;
  for (let j = 0; j < DEFAULT_ROW_LIMIT; j++) s += sorted[Math.floor(Math.random() * sorted.length)];
  sums.push(s);
}
sums.sort((a, b) => a - b);
console.log(
  `\n${DEFAULT_ROW_LIMIT}-row response tokens: p50=${pct(sums, 0.5)} ` +
  `p90=${pct(sums, 0.9)} p99=${pct(sums, 0.99)}`,
);
console.log('\nbudget   responses untouched   single pages held whole');
for (const b of CANDIDATES) {
  const responses = (sums.filter((s) => s <= b).length / sums.length) * 100;
  const singles = (sorted.filter((t) => t <= b).length / sorted.length) * 100;
  console.log(
    `${String(b).padStart(6)}   ${responses.toFixed(1).padStart(17)}%   ${singles.toFixed(1).padStart(21)}%`,
  );
}

// check_changes returns reports, not bodies. Cost the widest report shape and
// see how many fit the same budget.
const CHOSEN = 16000;
const widest = JSON.stringify({
  changes: pages.map((p) => ({
    url: p.url,
    changed: true,
    current_hash: p.hash,
    previous_hash: p.hash,
    diff_summary: '128 lines added, 94 lines removed, 12 lines modified',
  })),
});
const perReport = countTokens(widest) / pages.length;
console.log(
  `\ncheck_changes: unbounded=${widest.length} chars / ${countTokens(widest)} tokens ` +
  `over ${pages.length} entries`,
);
console.log(
  `widest report ~${perReport.toFixed(1)} tokens -> ${Math.floor(CHOSEN / perReport)} fit a ${CHOSEN}-token budget`,
);
db.close();
