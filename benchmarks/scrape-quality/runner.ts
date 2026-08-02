import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/logger.js';
import { extractContent } from '../../src/extraction/pipeline.js';
import { extractStructured } from '../../src/extraction/structured.js';
import { assertionKey, compareToBaseline, evaluateAssertion, renderMarkdown, scoreFixture, summarise } from './score.js';
import type { AssertionResult, Baseline, FixtureResult, ScrapeManifest, ScrapeReport } from './types.js';

const log = createLogger('extract');
const here = dirname(fileURLToPath(import.meta.url));

const MANIFEST = join(here, 'fixtures', 'manifest.json');
const HTML_DIR = join(here, 'fixtures', 'html');
const OUTPUT_DIR = join(here, 'output');
const BASELINE = join(here, 'baseline.json');

export function loadManifest(path = MANIFEST): ScrapeManifest {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ScrapeManifest;
  if (!Array.isArray(parsed.fixtures) || parsed.fixtures.length === 0) {
    throw new Error(`scrape-quality manifest has no fixtures: ${path}`);
  }
  return parsed;
}

export async function runFixture(
  fixture: ScrapeManifest['fixtures'][number],
  html: string,
): Promise<FixtureResult> {
  const t0 = Date.now();
  try {
    const extracted = await extractContent(html, fixture.url);
    const structured = extractStructured(html);
    const assertions: AssertionResult[] = fixture.assertions.map((a) =>
      evaluateAssertion(a, extracted.markdown, structured),
    );
    return {
      id: fixture.id,
      url: fixture.url,
      pageClass: fixture.pageClass,
      extractor: extracted.extractor,
      markdownChars: extracted.markdown.length,
      ms: Date.now() - t0,
      assertions,
      categoryScores: scoreFixture(assertions),
    };
  } catch (err) {
    // A throwing extractor fails every assertion rather than vanishing from the
    // denominator — otherwise a crash would read as a perfect score.
    const assertions: AssertionResult[] = fixture.assertions.map((a) => ({
      category: a.category,
      passed: false,
      describe: 'extraction threw',
      detail: String(err),
    }));
    return {
      id: fixture.id, url: fixture.url, pageClass: fixture.pageClass,
      extractor: 'unknown', markdownChars: 0, ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      assertions, categoryScores: scoreFixture(assertions),
    };
  }
}

export async function runBenchmark(opts: { manifestPath?: string; htmlDir?: string; filter?: string } = {}): Promise<ScrapeReport> {
  const t0 = Date.now();
  const manifest = loadManifest(opts.manifestPath ?? MANIFEST);
  const htmlDir = opts.htmlDir ?? HTML_DIR;
  const fixtures = opts.filter
    ? manifest.fixtures.filter((f) => f.id.includes(opts.filter!) || f.pageClass === opts.filter)
    : manifest.fixtures;
  if (fixtures.length === 0) throw new Error(`no fixtures match filter "${opts.filter}"`);

  const results: FixtureResult[] = [];
  for (const f of fixtures) {
    const path = join(htmlDir, f.htmlPath);
    if (!existsSync(path)) {
      // A missing snapshot is a hard error, not a skip. The old extraction corpus
      // silently referenced 21 HTML files that were never committed; a skip-on-missing
      // runner is how that survived unnoticed.
      throw new Error(`fixture snapshot missing: ${path} (referenced by ${f.id})`);
    }
    results.push(await runFixture(f, readFileSync(path, 'utf-8')));
  }

  return summarise(results, Date.now() - t0, new Date().toISOString());
}

export function writeBaseline(report: ScrapeReport, commit: string, note: string, path = BASELINE): Baseline {
  const assertions: Record<string, boolean> = {};
  for (const f of report.fixtures) {
    f.assertions.forEach((a, i) => { assertions[assertionKey(f.id, i, a.describe)] = a.passed; });
  }
  const baseline: Baseline = {
    takenAt: report.runDate,
    commit,
    note,
    overall: report.overall,
    byCategory: report.byCategory,
    assertions,
  };
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
  return baseline;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);

  const report = await runBenchmark({ filter: flag('filter') });

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'scrape-quality.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  if (has('write-baseline')) {
    const b = writeBaseline(report, flag('commit') ?? 'unknown', flag('note') ?? 'pre-S9 baseline');
    writeFileSync(join(OUTPUT_DIR, 'scrape-quality.md'), renderMarkdown(report), 'utf-8');
    log.info('baseline written', { assertions: Object.keys(b.assertions).length, score: b.overall.score });
    process.stderr.write(renderMarkdown(report));
    return;
  }

  let verdict;
  if (existsSync(BASELINE)) {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf-8')) as Baseline;
    verdict = compareToBaseline(report, baseline.assertions);
  }
  writeFileSync(join(OUTPUT_DIR, 'scrape-quality.md'), renderMarkdown(report, verdict), 'utf-8');
  // The report goes to stderr: this is a CLI, and stdout stays free for piping the
  // JSON when a caller wants it.
  process.stderr.write(renderMarkdown(report, verdict));

  if (verdict && !verdict.ok) {
    log.error('scrape-quality gate FAILED', { regressions: verdict.regressions.length });
    process.exitCode = 1;
  }
}

// Entry point. The extraction/search/agent runners omit this, which is why
// `npm run bench:extraction` exits 0 having done nothing and their workflows have
// been red since at least 2026-06-29.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error('scrape-quality benchmark crashed', { error: String(err) });
    process.exitCode = 1;
  });
}
