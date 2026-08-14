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
const DEFAULT_CHECK_LIMIT = 100; // DEFAULT_CHECK_CHANGES_LIMIT
const CANDIDATES = [4000, 8000, 12000, 16000, 20000, 40000];
const DRAWS = 20000;

/**
 * Seeded PRNG (mulberry32). The sampling below is what turns page sizes into
 * "% of responses untouched", and with an unseeded Math.random those figures
 * moved ~±0.4pp per run — enough that a reader re-checking a cited number could
 * not tell a real drift in the corpus from sampling noise. A provenance tool has
 * to be reproducible or it is not provenance. Override with SEED=<int>.
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.SEED ?? 20260815);
const rng = makeRng(SEED);

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

console.log(`corpus: ${dbPath}  (seed=${SEED}, draws=${DRAWS})`);
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
  for (let j = 0; j < DEFAULT_ROW_LIMIT; j++) s += sorted[Math.floor(rng() * sorted.length)];
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
//
// NOTE: this prices the WHOLE corpus as reports to get a per-report token cost.
// It is NOT a measurement of what the tool ever returned — the tool's own row cap
// bounds that, and always did. Reading this total as a tool-path figure is a
// mistake that has already been made once.
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
  `\ncheck_changes report cost (whole corpus priced as reports, NOT a tool-path ` +
  `figure): ${widest.length} chars / ${countTokens(widest)} tokens ` +
  `over ${pages.length} entries`,
);
console.log(
  `widest report ~${perReport.toFixed(1)} tokens -> ${Math.floor(CHOSEN / perReport)} fit a ${CHOSEN}-token budget`,
);

// ---------------------------------------------------------------------------
// Host distribution — the basis for MAX_CHECK_CHANGES_LIMIT.
//
// check_changes re-fetches every entry it reports on, so the cost that matters
// is requests aimed at ONE host, not requests in total. Grouping is by hostname
// with the port dropped: rate limits apply per host, and leaving the port on
// splits a run of ephemeral local ports into dozens of phantom hosts, which
// hides exactly the concentration this is measuring.
// ---------------------------------------------------------------------------
const rowsByRecency = db
  .prepare('SELECT url, normalized_url FROM url_cache ORDER BY fetched_at DESC')
  .all();

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};
const isLoopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';

function hostStats(rows, { dropLoopback }) {
  const counts = new Map();
  let skipped = 0;
  for (const r of rows) {
    const h = hostOf(r.url);
    if (h === null) continue;
    if (dropLoopback && isLoopback(h)) { skipped++; continue; }
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { hosts: counts.size, worst: ordered[0] ?? ['-', 0], top: ordered.slice(0, 3), skipped };
}

console.log('\nhost distribution (grouped by hostname, port dropped)');
for (const [label, rows] of [
  ['whole corpus', rowsByRecency],
  [`most recent ${DEFAULT_CHECK_LIMIT} (one default check run)`, rowsByRecency.slice(0, DEFAULT_CHECK_LIMIT)],
]) {
  for (const dropLoopback of [false, true]) {
    const s = hostStats(rows, { dropLoopback });
    console.log(
      `  ${label}${dropLoopback ? ', loopback excluded' : ''}: ` +
      `hosts=${s.hosts} worst=${s.worst[0]}@${s.worst[1]}` +
      (dropLoopback && s.skipped ? ` (dropped ${s.skipped} loopback rows)` : '') +
      `  top3=${s.top.map(([h, n]) => `${h}=${n}`).join(', ')}`,
    );
  }
}

// A scoped url_pattern is the documented usage and aims every request at one
// site, so price the globs a caller would actually write. GLOB is matched
// against normalized_url, exactly as searchCacheFiltered does.
console.log('\nworst-case scoped url_pattern (GLOB on normalized_url, as the tool matches it)');
const globCount = db.prepare('SELECT count(*) AS n FROM url_cache WHERE normalized_url GLOB ?');
const busiest = hostStats(rowsByRecency, { dropLoopback: true }).worst[0];
for (const pattern of [`*${busiest}*`, `https://${busiest}/*`]) {
  console.log(`  ${pattern.padEnd(34)} matches ${globCount.get(pattern).n}`);
}
db.close();
