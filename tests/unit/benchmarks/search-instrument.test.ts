/**
 * S14-0 / G-S14-0 — the retrieval instrument exists, its corpus can carry the thresholds S14 states, and
 * a run is reproducible.
 *
 * WHY AN INSTRUMENT NEEDS ITS OWN TESTS. The benchmark's output is what a later ranking gate would be
 * decided on, so a benchmark that silently measured nothing would make that gate a soft yes. Before this
 * slice `npm run bench:search` exited 0 having written no file at all — green in the way an unrun test is
 * green.
 *
 * ⚠️ WHAT THIS INSTRUMENT DOES **NOT** MEASURE, stated here because the number it produces will be read as
 * "search quality" otherwise: the runner maps the mock engine's results straight into the metrics. It does
 * not route them through the real post-merge ordering path (fusion, rerank, score floor), which is exactly
 * where a corpus rank signal would land. So these figures measure the CORPUS and the metric code, and are
 * a valid **regression** baseline; they are not a quality claim, and a rank-signal slice cannot be decided
 * on them without wiring that path first.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQueries, loadRelevanceJudgments, compareToBaseline, toBaseline, runSearchBenchmark, type SearchBaseline } from '../../../benchmarks/search/runner.js';
import { loadPrerecordedResponses } from '../../../benchmarks/search/mock-engine.js';
import type { SearchBenchmarkReport } from '../../../benchmarks/search/types.js';

const FIXTURES = join(process.cwd(), 'benchmarks/search/fixtures');
const RESPONSES = join(process.cwd(), 'benchmarks/search/responses');

/** The finest threshold any S14 gate states, per the spec's resolution arithmetic. */
const FINEST_S14_THRESHOLD = 0.05;

describe('G-S14-0b — the corpus can carry the thresholds S14 states', () => {
  it('holds at least 40 judged queries, so MRR resolution clears the finest threshold 2x', () => {
    // 1/N is the smallest MRR change one query can produce. A threshold within one resolution unit of the
    // corpus floor cannot tell a real effect from a single judgment flip, which is why the requirement is
    // 2x rather than "N such that 1/N < threshold".
    const queries = loadQueries(join(FIXTURES, 'queries.json'));
    expect(queries.length).toBeGreaterThanOrEqual(40);
    const resolution = 1 / queries.length;
    expect(resolution).toBeLessThanOrEqual(FINEST_S14_THRESHOLD / 2);
  });

  it('judges every query, so no query contributes a vacuous zero', () => {
    // An unjudged query scores 0 on every metric and drags the mean while looking like a measurement.
    const queries = loadQueries(join(FIXTURES, 'queries.json'));
    const judged = new Set(loadRelevanceJudgments(join(FIXTURES, 'relevance.json')).map((j) => j.queryId));
    const unjudged = queries.filter((q) => !judged.has(q.id)).map((q) => q.id);
    expect(unjudged, `unjudged queries: ${unjudged.join(', ')}`).toEqual([]);
  });

  it('has one response fixture per query, and no orphans', () => {
    // An orphan response inflates `responses.size` while matching no query; a missing one makes that
    // query return nothing and score 0.
    const queries = loadQueries(join(FIXTURES, 'queries.json'));
    const responses = loadPrerecordedResponses(RESPONSES);
    expect(responses.size).toBe(queries.length);
    for (const q of queries) expect(responses.has(q.id), `no response fixture for ${q.id}`).toBe(true);
  });

  it('every judged url appears in its query\'s own response list', () => {
    // A judgment pointing at a URL the fixture never returns is unreachable: it can only ever lower the
    // score, and it would do so for a reason no ranking change could fix.
    const responses = loadPrerecordedResponses(RESPONSES);
    const missing: string[] = [];
    for (const j of loadRelevanceJudgments(join(FIXTURES, 'relevance.json'))) {
      const urls = (responses.get(j.queryId)?.results ?? []).map((r) => r.url);
      if (!urls.includes(j.url)) missing.push(`${j.queryId} → ${j.url}`);
    }
    expect(missing, `unreachable judgments: ${missing.join('; ')}`).toEqual([]);
  });
});

describe('G-S14-0a — a run writes the report the gate names', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

  it('writes search-benchmark.json with the summary fields AND per-query rows', async () => {
    // The gate's own wording: the file exists, is non-empty, and contains `summary.meanReciprocalRank`,
    // `summary.averageNdcg` and per-query rows. Asserted by RUNNING the benchmark, because the previous
    // failure mode was a module whose exported function nobody called — a state no loader test can see.
    const out = mkdtempSync(join(tmpdir(), 'wg-bench-out-'));
    dirs.push(out);
    const report = await runSearchBenchmark({
      queriesPath: join(FIXTURES, 'queries.json'),
      relevancePath: join(FIXTURES, 'relevance.json'),
      responsesDir: RESPONSES,
      outputDir: out,
    });
    const path = join(out, 'search-benchmark.json');
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf-8')) as { summary: Record<string, number>; results: unknown[] };
    expect(written.summary.meanReciprocalRank).toBeGreaterThan(0);
    expect(written.summary.averageNdcg).toBeGreaterThan(0);
    expect(written.results.length).toBe(report.summary.totalQueries);
    expect(readFileSync(path, 'utf-8').length).toBeGreaterThan(1000);
  });

  it('is REPRODUCIBLE — two consecutive runs agree far inside the 0.001 tolerance', async () => {
    // G-S14-0c. The mock engine is deterministic; if two runs disagreed, something in the path is not,
    // and every later delta would be noise. Asserted per-query as well as on the mean, because two
    // queries moving in opposite directions can leave a mean unchanged.
    const a = mkdtempSync(join(tmpdir(), 'wg-bench-a-'));
    const b = mkdtempSync(join(tmpdir(), 'wg-bench-b-'));
    dirs.push(a, b);
    const opts = {
      queriesPath: join(FIXTURES, 'queries.json'),
      relevancePath: join(FIXTURES, 'relevance.json'),
      responsesDir: RESPONSES,
    };
    const r1 = await runSearchBenchmark({ ...opts, outputDir: a });
    const r2 = await runSearchBenchmark({ ...opts, outputDir: b });
    expect(Math.abs(r1.summary.meanReciprocalRank - r2.summary.meanReciprocalRank)).toBeLessThan(0.001);
    for (const row of r1.results) {
      const other = r2.results.find((x) => x.queryId === row.queryId);
      expect(other?.mrr, `per-query mrr drifted for ${row.queryId}`).toBe(row.mrr);
    }
  });

  it('matches the COMMITTED baseline, so the checked-in number is the one this corpus produces', async () => {
    // A baseline that no longer reproduces is worse than none: every later comparison would be against a
    // number the instrument cannot reach.
    const out = mkdtempSync(join(tmpdir(), 'wg-bench-c-'));
    dirs.push(out);
    const report = await runSearchBenchmark({
      queriesPath: join(FIXTURES, 'queries.json'),
      relevancePath: join(FIXTURES, 'relevance.json'),
      responsesDir: RESPONSES,
      outputDir: out,
    });
    const baseline = JSON.parse(readFileSync(join(FIXTURES, 'baseline.json'), 'utf-8')) as SearchBaseline;
    expect(Math.abs(report.summary.meanReciprocalRank - baseline.summary.meanReciprocalRank)).toBeLessThan(0.001);
    expect(compareToBaseline(report, baseline).regressions).toEqual([]);
  });
});

describe('the corpus is SYNTHETIC by construction, and says so per fixture', () => {
  it('marks every response `licence: synthetic`', () => {
    // Search-engine output may not be used as a fixture. A corpus with no licence field cannot be told
    // apart from a harvested one, which is why C0 carries the same field.
    const responses = loadPrerecordedResponses(RESPONSES);
    expect(responses.size).toBeGreaterThan(0);
    const unlicensed = [...responses.values()].filter((r) => r.licence !== 'synthetic').map((r) => r.queryId);
    expect(unlicensed, `responses missing a licence: ${unlicensed.join(', ')}`).toEqual([]);
  });

  it('keeps the generator committed beside its output, so the provenance claim is checkable', () => {
    // "Synthesised, not harvested" is only verifiable against the thing that did the synthesising.
    expect(existsSync(join(FIXTURES, 'corpus-spec.ts'))).toBe(true);
    expect(existsSync(join(FIXTURES, 'generate.ts'))).toBe(true);
  });
});

describe('G-S14-0a/c — the instrument runs, and its baseline is committed and comparable', () => {
  it('has a committed baseline with per-query rows, not only aggregates', () => {
    // An aggregate that held while two queries moved in opposite directions would report "no change" for
    // a real one.
    const path = join(FIXTURES, 'baseline.json');
    expect(existsSync(path)).toBe(true);
    const baseline = JSON.parse(readFileSync(path, 'utf-8')) as SearchBaseline;
    expect(baseline.queries).toBeGreaterThanOrEqual(40);
    expect(baseline.summary.meanReciprocalRank).toBeGreaterThan(0);
    expect(Object.keys(baseline.perQuery).length).toBe(baseline.queries);
  });

  it('sits mid-range rather than pinned at 1.0, so a change is visible in BOTH directions', () => {
    // A corpus where the answer always ranks first measures 1.0 and has no dynamic range: it cannot show
    // an improvement at all, and only shows a regression. That would be an instrument shaped so one of its
    // two possible findings is unreachable.
    const baseline = JSON.parse(readFileSync(join(FIXTURES, 'baseline.json'), 'utf-8')) as SearchBaseline;
    expect(baseline.summary.meanReciprocalRank).toBeGreaterThan(0.3);
    expect(baseline.summary.meanReciprocalRank).toBeLessThan(0.95);
  });

  it('reports a regression when a metric falls below the baseline', () => {
    const baseline = JSON.parse(readFileSync(join(FIXTURES, 'baseline.json'), 'utf-8')) as SearchBaseline;
    const worse = report({ meanReciprocalRank: baseline.summary.meanReciprocalRank - 0.05 });
    const { regressions } = compareToBaseline(worse, baseline);
    expect(regressions.join(' ')).toContain('meanReciprocalRank');
  });

  it('does NOT report a regression on an improvement, or on noise inside tolerance', () => {
    // The must-not-fire half. A comparator that flagged any difference would make every run red.
    const baseline = JSON.parse(readFileSync(join(FIXTURES, 'baseline.json'), 'utf-8')) as SearchBaseline;
    const better = report({ meanReciprocalRank: baseline.summary.meanReciprocalRank + 0.05 });
    expect(compareToBaseline(better, baseline).regressions).toEqual([]);
    const jitter = report({ meanReciprocalRank: baseline.summary.meanReciprocalRank - 0.0005 });
    expect(compareToBaseline(jitter, baseline).regressions).toEqual([]);
  });

  it('reports a SHRINKING corpus as a regression, because fewer queries is a weaker instrument', () => {
    // Dropping queries would raise every average while measuring less. Without this, the cheapest way to
    // "improve" the number would be to delete the queries that score badly.
    const baseline = JSON.parse(readFileSync(join(FIXTURES, 'baseline.json'), 'utf-8')) as SearchBaseline;
    const shrunk = report({}, baseline.queries - 5);
    expect(compareToBaseline(shrunk, baseline).regressions.join(' ')).toContain('corpus shrank');
  });

  it('carries per-query rows through toBaseline, keyed by query id', () => {
    const b = toBaseline(report({}, 2, [
      { queryId: 'a', mrr: 1, ndcg: 1 },
      { queryId: 'b', mrr: 0.5, ndcg: 0.6 },
    ]), 'deadbeef', 'test');
    expect(b.perQuery).toEqual({ a: { mrr: 1, ndcg: 1 }, b: { mrr: 0.5, ndcg: 0.6 } });
    expect(b.commit).toBe('deadbeef');
  });
});

/** A minimal report shaped like the runner's, for the comparator's own cases. */
function report(
  summary: Partial<SearchBenchmarkReport['summary']> = {},
  totalQueries = 45,
  rows: Array<{ queryId: string; mrr: number; ndcg: number }> = [],
): SearchBenchmarkReport {
  const base = JSON.parse(readFileSync(join(FIXTURES, 'baseline.json'), 'utf-8')) as SearchBaseline;
  return {
    runDate: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    summary: {
      totalQueries,
      successfulQueries: totalQueries,
      failedQueries: 0,
      averagePrecisionAt3: 0,
      averagePrecisionAt5: base.summary.averagePrecisionAt5,
      averagePrecisionAt10: 0,
      meanReciprocalRank: base.summary.meanReciprocalRank,
      averageNdcg: base.summary.averageNdcg,
      averageNdcgAt5: 0,
      averageNdcgAt10: base.summary.averageNdcgAt10,
      queryCoverage: base.summary.queryCoverage,
      latency: { p50: 1, p95: 1, p99: 1, mean: 1, min: 1, max: 1 },
      byCategory: {},
      ...summary,
    },
    results: rows.map((r) => ({
      queryId: r.queryId,
      query: r.queryId,
      category: 'docs',
      precisionAt3: 0,
      precisionAt5: 0,
      precisionAt10: 0,
      mrr: r.mrr,
      ndcg: r.ndcg,
      ndcgAt5: 0,
      ndcgAt10: 0,
      hasRelevantResult: true,
      resultCount: 10,
      latencyMs: 1,
    })),
  } as SearchBenchmarkReport;
}
