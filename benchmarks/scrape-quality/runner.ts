import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/logger.js';
import { extractContent } from '../../src/extraction/pipeline.js';
import { extractStructured } from '../../src/extraction/structured.js';
import { extractWithSchemaDetailed } from '../../src/extraction/schema.js';
import { assertionKey, compareToBaseline, evaluateAssertion, renderMarkdown, scoreFixture, summarise } from './score.js';
import type { AssertionResult, Baseline, FixtureResult, ScrapeManifest, ScrapeReport, SchemaProbe } from './types.js';

const log = createLogger('extract');
const here = dirname(fileURLToPath(import.meta.url));

const MANIFEST = join(here, 'fixtures', 'manifest.json');
const HTML_DIR = join(here, 'fixtures', 'html');
const OUTPUT_DIR = join(here, 'output');
const BASELINE = join(here, 'baseline.json');
/**
 * SD9-Q1 — the schema-mode half of the frozen baseline, in the same `Baseline` shape.
 *
 * A SECOND FILE rather than more rows in `baseline.json`, because that file is the frozen C0
 * snapshot taken at commit `5047f84a` BEFORE any bridge work, and its whole value is that
 * nobody has rewritten it since. Appending to it would re-date it and destroy the one property
 * the S9 comparison rests on. The two maps are merged at gate time, so the runner still emits
 * ONE verdict in ONE lane output — which is what the SD9 exit gate's 3ab arm reads.
 */
const SCHEMA_BASELINE = join(here, 'baseline-schema.json');

/** SD9-Q1 — the fixtures whose rows belong to the schema-mode snapshot: exactly those that
 *  declare a schema. Derived from the manifest, never a hand-kept id list that could drift. */
export function schemaFixtureIds(manifest: ScrapeManifest): Set<string> {
  return new Set(manifest.fixtures.filter((f) => f.schema !== undefined).map((f) => f.id));
}

/**
 * SD9-Q1 — the frozen verdicts the gate compares against: the C0 snapshot plus the schema-mode
 * extension, merged into the one per-assertion map `compareToBaseline` reads.
 *
 * Merged rather than compared twice on purpose. The SD9 exit gate's 3ab arm reads ONE lane
 * output; two verdicts would mean the arm could be satisfied by the half someone remembered to
 * look at. The keys are `fixtureId#index:describe` and the two files cover disjoint fixtures,
 * so the merge cannot silently overwrite a C0 row — but the collision is checked anyway,
 * because "cannot happen" is how a frozen number gets quietly replaced.
 */
export function loadFrozenAssertions(
  baselinePath = BASELINE,
  schemaPath = SCHEMA_BASELINE,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const path of [baselinePath, schemaPath]) {
    if (!existsSync(path)) continue;
    const b = JSON.parse(readFileSync(path, 'utf-8')) as Baseline;
    for (const [k, v] of Object.entries(b.assertions)) {
      if (k in out && out[k] !== v) throw new Error(`baseline collision on "${k}" between ${baselinePath} and ${schemaPath}`);
      out[k] = v;
    }
  }
  return out;
}

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
    // SD9-Q1 — schema mode runs only when the fixture declares a schema, and the probe carries
    // that schema alongside the result so every schema row can check it was actually asked
    // for. A fixture with no schema hands `undefined` through, and its schema rows (if anyone
    // adds one) fail loudly instead of scoring nothing.
    const schema: SchemaProbe | undefined = fixture.schema
      ? { declared: fixture.schema, result: extractWithSchemaDetailed(html, fixture.schema) }
      : undefined;
    // `sourceHtml` is the HTML THIS run extracted from — the live lane's rendered DOM on the
    // live lane, the frozen bytes on the frozen lane. `visible_only` checks non-vacuity
    // against it, so handing it the frozen bytes during a live run would let a node the
    // renderer removed still count as "present in the HTML".
    const assertions: AssertionResult[] = fixture.assertions.map((a) =>
      evaluateAssertion(a, extracted.markdown, structured, { sourceHtml: html, schema }),
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

export function writeBaseline(
  report: ScrapeReport,
  commit: string,
  note: string,
  path = BASELINE,
  /** SD9-Q1 — restrict the snapshot to one slice of the report (the schema-mode fixtures). */
  keep: (f: ScrapeReport['fixtures'][number]) => boolean = () => true,
): Baseline {
  const assertions: Record<string, boolean> = {};
  const fixtures = report.fixtures.filter(keep);
  if (fixtures.length === 0) throw new Error('refusing to write a baseline with no fixtures');
  for (const f of fixtures) {
    f.assertions.forEach((a, i) => { assertions[assertionKey(f.id, i, a.describe)] = a.passed; });
  }
  // Recomputed over the kept fixtures only: a schema-mode snapshot whose `overall` counted the
  // whole corpus would read as a schema number and be one. With the default `keep` this is the
  // same arithmetic over the same rows, so the full-baseline path is unchanged.
  const scoped = summarise(fixtures, report.durationMs, report.runDate);
  const baseline: Baseline = {
    takenAt: report.runDate,
    commit,
    note,
    overall: scoped.overall,
    // Empty categories are DROPPED rather than written as 0/0. `summarise` scores an empty
    // bucket 1 so that an absent category cannot drag the report down, which is right for a
    // live report and wrong for a frozen artifact: a schema-mode snapshot listing
    // `markdown_fidelity: 100%` over zero assertions is a number someone will eventually quote.
    byCategory: Object.fromEntries(Object.entries(scoped.byCategory).filter(([, v]) => v.total > 0)),
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

  const filter = flag('filter');
  const report = await runBenchmark({ filter });

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'scrape-quality.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  // S12-0 — the live lane. Dynamically imported so the frozen lane (the BLOCKING gate) never
  // pays for a browser it does not use, and so a missing browser binary cannot break the lane
  // that has to run on every PR.
  if (flag('lane') === 'live') {
    const { createBrowserReader, runLiveLane, compareLanes, renderParity } = await import('./live-lane.js');
    const seed = (flag('seed-regression') ?? 'none') as import('./live-lane.js').LiveSeed;
    const manifest = loadManifest();
    const reader = await createBrowserReader();
    let live;
    try {
      live = await runLiveLane({ manifest, htmlDir: HTML_DIR, reader, seed, filter });
    } finally {
      await reader.close();
    }
    const parity = compareLanes(manifest, report, live);
    writeFileSync(join(OUTPUT_DIR, 'scrape-quality-live.json'), `${JSON.stringify({ live, parity }, null, 2)}\n`, 'utf-8');
    const out = `${renderMarkdown(live)}${renderParity(parity)}`;
    writeFileSync(join(OUTPUT_DIR, 'scrape-quality-live.md'), out, 'utf-8');
    process.stderr.write(out);
    if (!parity.ok) {
      log.error('live-lane parity FAILED', { mismatches: parity.mismatches.length, seed });
      process.exitCode = 1;
    }
    return;
  }

  if (has('write-schema-baseline')) {
    // SD9-Q1 — the number is MEASURED here and frozen; it is never chosen. Re-running this
    // rewrites the snapshot, so it is a deliberate, separately-named flag rather than a
    // side effect of the ordinary `--write-baseline` path.
    const b = writeBaseline(
      report,
      flag('commit') ?? 'unknown',
      flag('note') ?? 'schema-mode baseline (SD9-Q1)',
      SCHEMA_BASELINE,
      (f) => schemaFixtureIds(loadManifest()).has(f.id),
    );
    writeFileSync(join(OUTPUT_DIR, 'scrape-quality.md'), renderMarkdown(report), 'utf-8');
    log.info('schema baseline written', { assertions: Object.keys(b.assertions).length, score: b.overall.score });
    process.stderr.write(renderMarkdown(report));
    return;
  }

  if (has('write-baseline')) {
    const b = writeBaseline(report, flag('commit') ?? 'unknown', flag('note') ?? 'pre-S9 baseline');
    writeFileSync(join(OUTPUT_DIR, 'scrape-quality.md'), renderMarkdown(report), 'utf-8');
    log.info('baseline written', { assertions: Object.keys(b.assertions).length, score: b.overall.score });
    process.stderr.write(renderMarkdown(report));
    return;
  }

  let verdict;
  const frozen = loadFrozenAssertions();
  if (Object.keys(frozen).length > 0) verdict = compareToBaseline(report, frozen);
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
