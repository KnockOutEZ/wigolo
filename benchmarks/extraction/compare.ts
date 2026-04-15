/**
 * Competitor extraction benchmark.
 *
 * Fetches each page via wigolo's extraction pipeline and each competitor
 * (Tavily, Firecrawl, Exa) whose API key is set in the environment. Computes
 * length, timing, heading/link counts, and pairwise F1 vs wigolo for each
 * provider. Results are cached on disk so repeat runs don't re-hit APIs.
 *
 * Usage:  npm run bench:compare
 *
 * Environment:
 *   TAVILY_API_KEY, FIRECRAWL_API_KEY, EXA_API_KEY — providers with missing
 *   keys are skipped (not errored).
 *   BENCH_COMPARE_REFRESH=1 — bypass the on-disk cache and re-fetch everything.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createLogger } from '../../src/logger.js';
import { extractContent } from '../../src/extraction/pipeline.js';
import { httpFetch } from '../../src/fetch/http-client.js';
import { computeF1, countHeadings, countLinks } from './metrics.js';

const log = createLogger('extract');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, '.compare-cache');
const OUTPUT_DIR = join(__dirname, 'output');

const RATE_LIMIT_MS = 1200;

interface CompetitorPage {
  id: string;
  url: string;
  category: string;
}

interface PagesManifest {
  version: string;
  description: string;
  pages: CompetitorPage[];
}

interface ProviderResult {
  provider: string;
  success: boolean;
  markdown: string;
  latencyMs: number;
  length: number;
  headingCount: number;
  linkCount: number;
  error?: string;
}

interface PageComparison {
  id: string;
  url: string;
  category: string;
  wigolo: ProviderResult;
  tavily?: ProviderResult;
  firecrawl?: ProviderResult;
  exa?: ProviderResult;
  /** Pairwise F1 against wigolo. Higher = more content overlap. */
  f1VsWigolo: Record<string, number>;
}

interface CompareReport {
  runDate: string;
  durationMs: number;
  providersActive: string[];
  providersSkipped: string[];
  pageCount: number;
  summary: Record<
    string,
    {
      successRate: number;
      averageLatencyMs: number;
      averageLength: number;
      averageF1VsWigolo: number;
    }
  >;
  results: PageComparison[];
}

function urlCacheKey(provider: string, url: string): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
  return `${provider}-${hash}.json`;
}

function readCache(provider: string, url: string): ProviderResult | null {
  if (process.env.BENCH_COMPARE_REFRESH === '1') return null;
  try {
    const path = join(CACHE_DIR, urlCacheKey(provider, url));
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as ProviderResult;
  } catch (err) {
    log.warn('cache read failed', { provider, url, error: String(err) });
    return null;
  }
}

function writeCache(provider: string, url: string, result: ProviderResult): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      join(CACHE_DIR, urlCacheKey(provider, url)),
      JSON.stringify(result, null, 2),
      'utf-8',
    );
  } catch (err) {
    log.warn('cache write failed', { provider, url, error: String(err) });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildResult(
  provider: string,
  markdown: string,
  latencyMs: number,
  error?: string,
): ProviderResult {
  const success = !error && markdown.length > 0;
  return {
    provider,
    success,
    markdown,
    latencyMs,
    length: markdown.length,
    headingCount: countHeadings(markdown),
    linkCount: countLinks(markdown),
    error,
  };
}

interface ProviderOutcome {
  result: ProviderResult;
  fromCache: boolean;
}

async function fetchWigolo(url: string): Promise<ProviderOutcome> {
  const cached = readCache('wigolo', url);
  if (cached) return { result: cached, fromCache: true };

  const start = Date.now();
  try {
    const raw = await httpFetch(url);
    const result = await extractContent(raw.html, raw.finalUrl, {
      contentType: raw.contentType,
    });
    const out = buildResult('wigolo', result.markdown, Date.now() - start);
    writeCache('wigolo', url, out);
    return { result: out, fromCache: false };
  } catch (err) {
    const out = buildResult('wigolo', '', Date.now() - start, String(err));
    writeCache('wigolo', url, out);
    return { result: out, fromCache: false };
  }
}

async function fetchTavily(url: string, apiKey: string): Promise<ProviderOutcome> {
  const cached = readCache('tavily', url);
  if (cached) return { result: cached, fromCache: true };

  const start = Date.now();
  try {
    const response = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        urls: [url],
        extract_depth: 'advanced',
        format: 'markdown',
      }),
    });
    if (!response.ok) {
      throw new Error(`Tavily ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      results?: Array<{ url: string; raw_content?: string }>;
    };
    const first = data.results?.[0];
    const markdown = first?.raw_content ?? '';
    const out = buildResult('tavily', markdown, Date.now() - start);
    writeCache('tavily', url, out);
    return { result: out, fromCache: false };
  } catch (err) {
    const out = buildResult('tavily', '', Date.now() - start, String(err));
    writeCache('tavily', url, out);
    return { result: out, fromCache: false };
  }
}

async function fetchFirecrawl(url: string, apiKey: string): Promise<ProviderOutcome> {
  const cached = readCache('firecrawl', url);
  if (cached) return { result: cached, fromCache: true };

  const start = Date.now();
  try {
    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
      }),
    });
    if (!response.ok) {
      throw new Error(`Firecrawl ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      data?: { markdown?: string };
      markdown?: string;
    };
    const markdown = data.data?.markdown ?? data.markdown ?? '';
    const out = buildResult('firecrawl', markdown, Date.now() - start);
    writeCache('firecrawl', url, out);
    return { result: out, fromCache: false };
  } catch (err) {
    const out = buildResult('firecrawl', '', Date.now() - start, String(err));
    writeCache('firecrawl', url, out);
    return { result: out, fromCache: false };
  }
}

async function fetchExa(url: string, apiKey: string): Promise<ProviderOutcome> {
  const cached = readCache('exa', url);
  if (cached) return { result: cached, fromCache: true };

  const start = Date.now();
  try {
    const response = await fetch('https://api.exa.ai/contents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ urls: [url], text: true }),
    });
    if (!response.ok) {
      throw new Error(`Exa ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      results?: Array<{ url: string; text?: string }>;
    };
    const first = data.results?.[0];
    const markdown = first?.text ?? '';
    const out = buildResult('exa', markdown, Date.now() - start);
    writeCache('exa', url, out);
    return { result: out, fromCache: false };
  } catch (err) {
    const out = buildResult('exa', '', Date.now() - start, String(err));
    writeCache('exa', url, out);
    return { result: out, fromCache: false };
  }
}

function loadPages(): PagesManifest {
  const path = join(__dirname, 'competitor-pages.json');
  if (!existsSync(path)) {
    throw new Error(`competitor-pages.json not found at ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as PagesManifest;
}

function computeSummary(
  results: PageComparison[],
  active: string[],
): CompareReport['summary'] {
  const summary: CompareReport['summary'] = {};

  for (const provider of active) {
    const samples = results
      .map(r => (r as unknown as Record<string, ProviderResult | undefined>)[provider])
      .filter((r): r is ProviderResult => r !== undefined);
    if (samples.length === 0) continue;

    const successes = samples.filter(s => s.success);
    const avgLatency = successes.length
      ? successes.reduce((sum, s) => sum + s.latencyMs, 0) / successes.length
      : 0;
    const avgLength = successes.length
      ? successes.reduce((sum, s) => sum + s.length, 0) / successes.length
      : 0;

    const f1Values = results
      .map(r => r.f1VsWigolo[provider])
      .filter(f => typeof f === 'number' && !Number.isNaN(f));
    const avgF1 = f1Values.length
      ? f1Values.reduce((sum, v) => sum + v, 0) / f1Values.length
      : 0;

    summary[provider] = {
      successRate: successes.length / samples.length,
      averageLatencyMs: Math.round(avgLatency),
      averageLength: Math.round(avgLength),
      averageF1VsWigolo: Number(avgF1.toFixed(3)),
    };
  }

  return summary;
}

function generateMarkdown(report: CompareReport): string {
  const lines: string[] = [];
  lines.push('# Competitor Extraction Benchmark');
  lines.push('');
  lines.push(`Run: ${report.runDate}`);
  lines.push(`Duration: ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Pages: ${report.pageCount}`);
  lines.push(`Active providers: ${report.providersActive.join(', ')}`);
  if (report.providersSkipped.length > 0) {
    lines.push(`Skipped (no API key): ${report.providersSkipped.join(', ')}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Provider | Success | Avg Latency (ms) | Avg Length | Avg F1 vs wigolo |');
  lines.push('|----------|---------|------------------|-----------:|-----------------:|');
  for (const [provider, s] of Object.entries(report.summary)) {
    const f1 = provider === 'wigolo' ? '—' : s.averageF1VsWigolo.toFixed(3);
    lines.push(
      `| ${provider} | ${(s.successRate * 100).toFixed(0)}% | ${s.averageLatencyMs} | ${s.averageLength} | ${f1} |`,
    );
  }
  lines.push('');
  lines.push('## Per-page results');
  lines.push('');
  for (const r of report.results) {
    lines.push(`### ${r.id} (${r.category})`);
    lines.push('');
    lines.push(`URL: ${r.url}`);
    lines.push('');
    lines.push('| Provider | Status | Latency (ms) | Length | Headings | Links | F1 vs wigolo |');
    lines.push('|----------|--------|-------------:|-------:|---------:|------:|-------------:|');
    const providers: Array<[string, ProviderResult | undefined]> = [
      ['wigolo', r.wigolo],
      ['tavily', r.tavily],
      ['firecrawl', r.firecrawl],
      ['exa', r.exa],
    ];
    for (const [name, res] of providers) {
      if (!res) continue;
      const status = res.success ? 'ok' : `fail: ${res.error?.slice(0, 40) ?? 'unknown'}`;
      const f1 = name === 'wigolo' ? '—' : (r.f1VsWigolo[name] ?? 0).toFixed(3);
      lines.push(
        `| ${name} | ${status} | ${res.latencyMs} | ${res.length} | ${res.headingCount} | ${res.linkCount} | ${f1} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const manifest = loadPages();

  const tavilyKey = process.env.TAVILY_API_KEY;
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  const exaKey = process.env.EXA_API_KEY;

  const active: string[] = ['wigolo'];
  const skipped: string[] = [];
  if (tavilyKey) active.push('tavily');
  else skipped.push('tavily');
  if (firecrawlKey) active.push('firecrawl');
  else skipped.push('firecrawl');
  if (exaKey) active.push('exa');
  else skipped.push('exa');

  log.info('starting competitor extraction benchmark', {
    pages: manifest.pages.length,
    active,
    skipped,
  });

  const results: PageComparison[] = [];

  for (const page of manifest.pages) {
    log.info('comparing page', { id: page.id, url: page.url });

    const wigoloOutcome = await fetchWigolo(page.url);
    const wigolo = wigoloOutcome.result;
    if (!wigoloOutcome.fromCache) await sleep(RATE_LIMIT_MS);

    const comparison: PageComparison = {
      id: page.id,
      url: page.url,
      category: page.category,
      wigolo,
      f1VsWigolo: {},
    };

    if (tavilyKey) {
      const out = await fetchTavily(page.url, tavilyKey);
      comparison.tavily = out.result;
      if (!out.fromCache) await sleep(RATE_LIMIT_MS);
      if (out.result.success && wigolo.success) {
        comparison.f1VsWigolo.tavily = computeF1(out.result.markdown, wigolo.markdown);
      }
    }

    if (firecrawlKey) {
      const out = await fetchFirecrawl(page.url, firecrawlKey);
      comparison.firecrawl = out.result;
      if (!out.fromCache) await sleep(RATE_LIMIT_MS);
      if (out.result.success && wigolo.success) {
        comparison.f1VsWigolo.firecrawl = computeF1(out.result.markdown, wigolo.markdown);
      }
    }

    if (exaKey) {
      const out = await fetchExa(page.url, exaKey);
      comparison.exa = out.result;
      if (!out.fromCache) await sleep(RATE_LIMIT_MS);
      if (out.result.success && wigolo.success) {
        comparison.f1VsWigolo.exa = computeF1(out.result.markdown, wigolo.markdown);
      }
    }

    results.push(comparison);
  }

  const durationMs = Date.now() - startTime;
  const summary = computeSummary(results, active);

  const report: CompareReport = {
    runDate: new Date().toISOString(),
    durationMs,
    providersActive: active,
    providersSkipped: skipped,
    pageCount: manifest.pages.length,
    summary,
    results,
  };

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    join(OUTPUT_DIR, 'compare-report.json'),
    JSON.stringify(report, null, 2),
    'utf-8',
  );
  writeFileSync(join(OUTPUT_DIR, 'compare-report.md'), generateMarkdown(report), 'utf-8');

  log.info('competitor benchmark complete', {
    durationMs,
    pages: results.length,
    active,
    outputDir: OUTPUT_DIR,
  });

  // Human-readable summary to stdout for CI logs
  const stdout = process.stdout;
  stdout.write('\n=== Competitor Extraction Benchmark ===\n');
  stdout.write(`Pages: ${results.length}  Duration: ${(durationMs / 1000).toFixed(1)}s\n`);
  stdout.write(`Active: ${active.join(', ')}\n`);
  if (skipped.length > 0) stdout.write(`Skipped (no key): ${skipped.join(', ')}\n`);
  stdout.write('\n');
  for (const [provider, s] of Object.entries(summary)) {
    const f1 = provider === 'wigolo' ? '—' : s.averageF1VsWigolo.toFixed(3);
    stdout.write(
      `${provider.padEnd(10)} success=${(s.successRate * 100).toFixed(0).padStart(3)}%  ` +
        `latency=${String(s.averageLatencyMs).padStart(5)}ms  ` +
        `length=${String(s.averageLength).padStart(6)}  f1=${f1}\n`,
    );
  }
  stdout.write(`\nReport: ${join(OUTPUT_DIR, 'compare-report.md')}\n`);
}

main().catch(err => {
  log.error('competitor benchmark failed', { error: String(err) });
  process.exit(1);
});
