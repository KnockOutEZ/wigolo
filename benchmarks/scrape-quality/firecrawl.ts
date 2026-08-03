/**
 * C0 — the LIVE half of the D6 hybrid gate: wigolo vs Firecrawl, head to head.
 *
 * Never runs on `pull_request`. Live sites and a paid API in every PR is how a gate
 * becomes flaky, expensive and then disabled. This is cron / workflow_dispatch / local only;
 * the deterministic frozen-fixture gate in `runner.ts` is what blocks a merge.
 *
 * Both sides are scored with the SAME assertions the frozen corpus uses, against the SAME
 * live URLs, so the comparison is on identical criteria rather than on vibes. Content drift
 * between the snapshot date and the run date is real and is reported, not hidden: an
 * assertion that fails for BOTH engines is far more likely to be drift than a regression.
 *
 *   npx tsx benchmarks/scrape-quality/firecrawl.ts [--filter=<id>] [--out=<path>]
 *
 * Keys: FIRECRAWL_API_KEYS (comma-separated pool) or FIRECRAWL_API_KEY (single). Absent ⇒
 * the runner reports "skipped, no key" and exits 0 — a missing key is not a failure.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/logger.js';
import { extractStructured } from '../../src/extraction/structured.js';
import { evaluateAssertion } from './score.js';
import type { AssertionResult, ScrapeManifest } from './types.js';
import type { StructuredData } from '../../src/types.js';

const log = createLogger('extract');
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, 'fixtures', 'manifest.json');
const OUTPUT_DIR = join(here, 'output');

const EMPTY_STRUCTURED: StructuredData = {
  tables: [], definitions: [], jsonld: [], chart_hints: [], key_value_pairs: [],
};

/* ------------------------------------------------------------------ key pool */

/**
 * Round-robin over the free-tier accounts, with failover to the next key on the responses
 * that mean "this account is done for now" (402 out of credits, 429 rate-limited, 401/403
 * bad key). Each key is tried at most once per request; when every key has failed the
 * request reports the last status rather than retrying forever.
 */
export class KeyPool {
  private idx = 0;
  private readonly dead = new Set<string>();

  constructor(private readonly keys: string[]) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): KeyPool {
    const pooled = (env.FIRECRAWL_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    const single = (env.FIRECRAWL_API_KEY ?? '').trim();
    const keys = pooled.length > 0 ? pooled : single ? [single] : [];
    return new KeyPool(keys);
  }

  get size(): number { return this.keys.length; }
  get live(): number { return this.keys.filter((k) => !this.dead.has(k)).length; }

  /** Keys to try for one request, starting at the rotating cursor, skipping exhausted ones. */
  *candidates(): Generator<{ key: string; label: string }> {
    const n = this.keys.length;
    for (let i = 0; i < n; i += 1) {
      const at = (this.idx + i) % n;
      const key = this.keys[at];
      if (this.dead.has(key)) continue;
      // Label by position, never by value — keys must not reach logs or reports.
      yield { key, label: `key#${at + 1}` };
    }
    this.idx = n === 0 ? 0 : (this.idx + 1) % n;
  }

  /** Mark a key exhausted for the rest of this run (402/429 → out of credits / throttled). */
  retire(key: string): void { this.dead.add(key); }
}

const RETRY_STATUS = new Set([401, 402, 403, 429]);

export interface ScrapeOutcome {
  ok: boolean;
  markdown: string;
  status?: number;
  keyLabel?: string;
  error?: string;
  ms: number;
}

export async function firecrawlScrape(
  url: string,
  pool: KeyPool,
  fetchImpl: typeof fetch = fetch,
): Promise<ScrapeOutcome> {
  const t0 = Date.now();
  let last: { status?: number; error?: string } = {};
  for (const { key, label } of pool.candidates()) {
    try {
      const res = await fetchImpl('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });
      if (RETRY_STATUS.has(res.status)) {
        // Out of credits or throttled: retire this account and roll to the next.
        pool.retire(key);
        last = { status: res.status, error: `${label} exhausted (HTTP ${res.status})` };
        log.warn('firecrawl key exhausted, rotating', { keyLabel: label, status: res.status });
        continue;
      }
      if (!res.ok) {
        last = { status: res.status, error: `HTTP ${res.status}` };
        break;
      }
      const body = (await res.json()) as { success?: boolean; data?: { markdown?: string } };
      return {
        ok: Boolean(body.success),
        markdown: body.data?.markdown ?? '',
        status: res.status,
        keyLabel: label,
        ms: Date.now() - t0,
      };
    } catch (err) {
      last = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, markdown: '', ...last, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------- wigolo's own side */

async function wigoloScrape(url: string): Promise<ScrapeOutcome & { structured: StructuredData }> {
  const t0 = Date.now();
  const { initDatabase } = await import('../../src/cache/db.js');
  const { SmartRouter } = await import('../../src/fetch/router.js');
  const { MultiBrowserPool } = await import('../../src/fetch/browser-pool.js');
  const { httpFetch } = await import('../../src/fetch/http-client.js');
  const { handleFetch } = await import('../../src/tools/fetch.js');
  const { getConfig } = await import('../../src/config.js');

  const config = getConfig();
  mkdirSync(config.dataDir, { recursive: true });
  initDatabase(join(config.dataDir, 'wigolo.db'));
  const pool = new MultiBrowserPool({ browserTypes: config.browserTypes, selectionStrategy: 'round-robin' });
  const router = new SmartRouter({ fetch: (u, o) => httpFetch(u, o) }, pool);
  try {
    // force_refresh: a cached hit would replay an older pipeline and silently flatter us.
    const res = await handleFetch({ url, force_refresh: true }, router);
    const markdown = res.ok ? ((res.data as { markdown?: string }).markdown ?? '') : '';
    const html = res.ok ? ((res.data as { raw_html?: string }).raw_html ?? '') : '';
    return {
      ok: res.ok,
      markdown,
      error: res.ok ? undefined : (res as { error?: string }).error,
      ms: Date.now() - t0,
      // Structured extraction needs HTML; when the tool did not return raw HTML the
      // structured assertions are scored against an empty set for BOTH engines (Firecrawl
      // returns markdown only), so neither side is advantaged.
      structured: html ? extractStructured(html) : EMPTY_STRUCTURED,
    };
  } finally {
    await pool.shutdown().catch(() => {});
  }
}

/* -------------------------------------------------------------------- comparison */

export interface EngineScore { passed: number; total: number; failing: string[] }

export function scoreMarkdown(
  assertions: ScrapeManifest['fixtures'][number]['assertions'],
  markdown: string,
  structured: StructuredData,
): EngineScore {
  // Structured-shape assertions are dropped: Firecrawl's scrape returns markdown only, so
  // scoring them would compare wigolo against an absent capability rather than against
  // Firecrawl's extraction quality. They are covered by the frozen-fixture gate instead.
  const applicable = assertions.filter((a) => a.kind !== 'structured' && a.kind !== 'table_cell');
  const results: AssertionResult[] = applicable.map((a) => evaluateAssertion(a, markdown, structured));
  return {
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    failing: results.filter((r) => !r.passed).map((r) => r.describe),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

  const pool = KeyPool.fromEnv();
  if (pool.size === 0) {
    process.stderr.write('firecrawl comparison SKIPPED — no FIRECRAWL_API_KEYS / FIRECRAWL_API_KEY set.\n');
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as ScrapeManifest;
  const filter = flag('filter');
  const fixtures = filter ? manifest.fixtures.filter((f) => f.id.includes(filter)) : manifest.fixtures;

  const rows: string[] = [];
  const antibot: string[] = [];
  let wTotal = 0, wPass = 0, fTotal = 0, fPass = 0;
  const detail: string[] = [];

  for (const f of fixtures) {
    const [w, fc] = [await wigoloScrape(f.url), await firecrawlScrape(f.url, pool)];

    // A challenge_shell fixture's assertions describe the INTERSTITIAL that was captured
    // ("contains 'Just a moment'", "char <= 400"). Live, an engine that defeats the wall and
    // returns the real page FAILS those assertions — scoring it would credit being blocked.
    // Report the anti-bot outcome plainly instead, and keep it out of the totals.
    if (f.pageClass === 'challenge_shell') {
      const verdict = (o: ScrapeOutcome) =>
        o.ok && o.markdown.length > 2000 ? `PASSED the wall · ${o.markdown.length} ch`
          : o.ok ? `thin result · ${o.markdown.length} ch`
            : `blocked · ${o.error ?? 'failed'}`;
      antibot.push(`| ${f.url.replace(/^https?:\/\//, '').slice(0, 60)} | ${verdict(w)} · ${w.ms} ms | ${verdict(fc)} · ${fc.ms} ms |`);
      continue;
    }

    const ws = scoreMarkdown(f.assertions, w.markdown, w.structured);
    const fs2 = scoreMarkdown(f.assertions, fc.markdown, EMPTY_STRUCTURED);
    wTotal += ws.total; wPass += ws.passed; fTotal += fs2.total; fPass += fs2.passed;

    rows.push(`| ${f.id} | ${f.pageClass} | ${ws.passed}/${ws.total} · ${w.markdown.length} ch · ${w.ms} ms${w.ok ? '' : ` · ${w.error}`} | ${fs2.passed}/${fs2.total} · ${fc.markdown.length} ch · ${fc.ms} ms${fc.ok ? '' : ` · ${fc.error ?? 'failed'}`} |`);

    // Assertions BOTH engines fail are the drift signal, and are called out separately so a
    // stale snapshot does not read as a wigolo defect.
    const both = ws.failing.filter((x) => fs2.failing.includes(x));
    const onlyW = ws.failing.filter((x) => !fs2.failing.includes(x));
    const onlyF = fs2.failing.filter((x) => !ws.failing.includes(x));
    if (both.length || onlyW.length || onlyF.length) {
      detail.push(`\n**${f.id}**`);
      for (const x of both) detail.push(`- both fail (likely page drift since capture): ${x}`);
      for (const x of onlyW) detail.push(`- wigolo only: ${x}`);
      for (const x of onlyF) detail.push(`- firecrawl only: ${x}`);
    }
  }

  const md = [
    '# wigolo vs Firecrawl — live scrape comparison (C0, cron/dispatch lane)',
    '',
    `Run: ${new Date().toISOString()} · ${fixtures.length} live URLs · key pool ${pool.live}/${pool.size} live at end`,
    '',
    `**wigolo ${wPass}/${wTotal} · Firecrawl ${fPass}/${fTotal}** (same assertions, same URLs, structured-shape assertions excluded — Firecrawl scrape returns markdown only)`,
    '',
    '| Fixture | Page class | wigolo | Firecrawl |',
    '|---|---|---|---|',
    ...rows,
    '',
    ...(antibot.length
      ? ['## Anti-bot outcome (scored separately — NOT in the totals above)', '',
         '| URL | wigolo | Firecrawl |', '|---|---|---|', ...antibot, '']
      : []),
    '## Assertion detail',
    ...(detail.length ? detail : ['_no failures on either side_']),
    '',
    '_Live lane: page content may have drifted since the frozen snapshots were captured. An assertion failing on BOTH engines is drift, not a regression._',
  ].join('\n');

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const out = flag('out') ?? join(OUTPUT_DIR, 'firecrawl-comparison.md');
  writeFileSync(out, `${md}\n`, 'utf-8');
  process.stderr.write(`${md}\n`);
  log.info('firecrawl comparison complete', { wigolo: `${wPass}/${wTotal}`, firecrawl: `${fPass}/${fTotal}` });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error('firecrawl comparison crashed', { error: String(err) });
    process.exitCode = 1;
  });
}
