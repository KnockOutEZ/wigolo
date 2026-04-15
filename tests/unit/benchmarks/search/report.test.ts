import { describe, it, expect } from 'vitest';
import {
  computeSearchSummary,
  generateSearchMarkdownReport,
  generateSearchJsonReport,
} from '../../../../benchmarks/search/report.js';
import type {
  QueryMetricResult,
  SearchBenchmarkReport,
} from '../../../../benchmarks/search/types.js';

function makeQueryResult(overrides: Partial<QueryMetricResult> = {}): QueryMetricResult {
  return {
    queryId: 'q1',
    query: 'test query',
    category: 'docs',
    precisionAt3: 0.67,
    precisionAt5: 0.6,
    precisionAt10: 0.4,
    mrr: 1,
    ndcg: 0.85,
    ndcgAt5: 0.8,
    ndcgAt10: 0.75,
    hasRelevantResult: true,
    resultCount: 10,
    latencyMs: 150,
    ...overrides,
  };
}

describe('computeSearchSummary', () => {
  it('computes correct averages for single result', () => {
    const results = [makeQueryResult()];
    const summary = computeSearchSummary(results);
    expect(summary.totalQueries).toBe(1);
    expect(summary.successfulQueries).toBe(1);
    expect(summary.failedQueries).toBe(0);
    expect(summary.averagePrecisionAt3).toBeCloseTo(0.67);
    expect(summary.meanReciprocalRank).toBeCloseTo(1);
    expect(summary.averageNdcg).toBeCloseTo(0.85);
    expect(summary.queryCoverage).toBe(1);
  });

  it('computes correct averages for multiple results', () => {
    const results = [
      makeQueryResult({ mrr: 1, ndcg: 0.9 }),
      makeQueryResult({ mrr: 0.5, ndcg: 0.7 }),
    ];
    const summary = computeSearchSummary(results);
    expect(summary.meanReciprocalRank).toBeCloseTo(0.75);
    expect(summary.averageNdcg).toBeCloseTo(0.8);
  });

  it('counts failures correctly', () => {
    const results = [
      makeQueryResult(),
      makeQueryResult({ error: 'timeout' }),
    ];
    const summary = computeSearchSummary(results);
    expect(summary.failedQueries).toBe(1);
    expect(summary.successfulQueries).toBe(1);
  });

  it('computes query coverage', () => {
    const results = [
      makeQueryResult({ hasRelevantResult: true }),
      makeQueryResult({ hasRelevantResult: true }),
      makeQueryResult({ hasRelevantResult: false }),
    ];
    const summary = computeSearchSummary(results);
    expect(summary.queryCoverage).toBeCloseTo(2 / 3);
  });

  it('groups by category', () => {
    const results = [
      makeQueryResult({ category: 'docs', mrr: 1 }),
      makeQueryResult({ category: 'docs', mrr: 0.5 }),
      makeQueryResult({ category: 'error', mrr: 0.33 }),
    ];
    const summary = computeSearchSummary(results);
    expect(summary.byCategory['docs'].count).toBe(2);
    expect(summary.byCategory['docs'].averageMrr).toBeCloseTo(0.75);
    expect(summary.byCategory['error'].count).toBe(1);
  });

  it('computes latency percentiles', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeQueryResult({ latencyMs: (i + 1) * 10 }),
    );
    const summary = computeSearchSummary(results);
    expect(summary.latency.min).toBe(10);
    expect(summary.latency.max).toBe(200);
    expect(summary.latency.mean).toBeCloseTo(105);
  });

  it('handles empty results', () => {
    const summary = computeSearchSummary([]);
    expect(summary.totalQueries).toBe(0);
    expect(summary.meanReciprocalRank).toBe(0);
    expect(summary.queryCoverage).toBe(0);
  });
});

describe('generateSearchMarkdownReport', () => {
  it('generates markdown with summary table', () => {
    const report: SearchBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 3000,
      summary: computeSearchSummary([makeQueryResult()]),
      results: [makeQueryResult()],
    };
    const md = generateSearchMarkdownReport(report);
    expect(md).toContain('# Search Benchmark Report');
    expect(md).toContain('Precision@3');
    expect(md).toContain('MRR');
    expect(md).toContain('NDCG');
    expect(md).toContain('Coverage');
  });

  it('includes per-query results table', () => {
    const report: SearchBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 3000,
      summary: computeSearchSummary([makeQueryResult({ queryId: 'specific-q' })]),
      results: [makeQueryResult({ queryId: 'specific-q' })],
    };
    const md = generateSearchMarkdownReport(report);
    expect(md).toContain('specific-q');
  });

  it('includes latency section', () => {
    const report: SearchBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 3000,
      summary: computeSearchSummary([makeQueryResult()]),
      results: [makeQueryResult()],
    };
    const md = generateSearchMarkdownReport(report);
    expect(md).toContain('p50');
    expect(md).toContain('p95');
  });

  it('handles empty results', () => {
    const report: SearchBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 100,
      summary: computeSearchSummary([]),
      results: [],
    };
    const md = generateSearchMarkdownReport(report);
    expect(md).toContain('# Search Benchmark Report');
  });
});

describe('generateSearchJsonReport', () => {
  it('produces valid JSON', () => {
    const report: SearchBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 3000,
      summary: computeSearchSummary([makeQueryResult()]),
      results: [makeQueryResult()],
    };
    const json = generateSearchJsonReport(report);
    const parsed = JSON.parse(json);
    expect(parsed.runDate).toBe('2026-04-14T12:00:00Z');
    expect(parsed.results).toHaveLength(1);
  });
});
