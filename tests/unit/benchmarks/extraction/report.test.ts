import { describe, it, expect } from 'vitest';
import {
  computeSummary,
  generateMarkdownReport,
  generateJsonReport,
} from '../../../../benchmarks/extraction/report.js';
import type {
  ExtractionBenchmarkResult,
  BenchmarkReport,
  MetricResult,
} from '../../../../benchmarks/extraction/types.js';

function makeMetric(overrides: Partial<MetricResult> = {}): MetricResult {
  return {
    precision: 0.8,
    recall: 0.7,
    f1: 0.746,
    rougeL: 0.72,
    headingCountMatch: true,
    headingCountExpected: 3,
    headingCountActual: 3,
    linkCountMatch: true,
    linkCountExpected: 5,
    linkCountActual: 5,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ExtractionBenchmarkResult> = {}): ExtractionBenchmarkResult {
  return {
    id: 'test-001',
    url: 'https://example.com/page',
    category: 'article',
    extractorUsed: 'defuddle',
    expectedExtractor: 'defuddle',
    extractorMatch: true,
    metrics: makeMetric(),
    extractionTimeMs: 120,
    markdownLength: 5000,
    goldenLength: 4800,
    ...overrides,
  };
}

describe('computeSummary', () => {
  it('computes correct averages for single result', () => {
    const results = [makeResult()];
    const summary = computeSummary(results);
    expect(summary.totalEntries).toBe(1);
    expect(summary.successfulEntries).toBe(1);
    expect(summary.failedEntries).toBe(0);
    expect(summary.averagePrecision).toBeCloseTo(0.8);
    expect(summary.averageRecall).toBeCloseTo(0.7);
    expect(summary.averageF1).toBeCloseTo(0.746);
    expect(summary.averageRougeL).toBeCloseTo(0.72);
    expect(summary.extractorMatchRate).toBe(1);
  });

  it('computes correct averages for multiple results', () => {
    const results = [
      makeResult({ metrics: makeMetric({ f1: 0.8, rougeL: 0.75, precision: 0.9, recall: 0.7 }) }),
      makeResult({ metrics: makeMetric({ f1: 0.6, rougeL: 0.55, precision: 0.7, recall: 0.5 }) }),
    ];
    const summary = computeSummary(results);
    expect(summary.averageF1).toBeCloseTo(0.7);
    expect(summary.averageRougeL).toBeCloseTo(0.65);
    expect(summary.averagePrecision).toBeCloseTo(0.8);
    expect(summary.averageRecall).toBeCloseTo(0.6);
  });

  it('counts failures correctly', () => {
    const results = [
      makeResult(),
      makeResult({ error: 'extraction failed' }),
    ];
    const summary = computeSummary(results);
    expect(summary.totalEntries).toBe(2);
    expect(summary.failedEntries).toBe(1);
    expect(summary.successfulEntries).toBe(1);
  });

  it('groups by category correctly', () => {
    const results = [
      makeResult({ category: 'article', metrics: makeMetric({ f1: 0.9 }) }),
      makeResult({ category: 'article', metrics: makeMetric({ f1: 0.7 }) }),
      makeResult({ category: 'docs', metrics: makeMetric({ f1: 0.6 }) }),
    ];
    const summary = computeSummary(results);
    expect(summary.byCategory['article'].count).toBe(2);
    expect(summary.byCategory['article'].averageF1).toBeCloseTo(0.8);
    expect(summary.byCategory['docs'].count).toBe(1);
    expect(summary.byCategory['docs'].averageF1).toBeCloseTo(0.6);
  });

  it('groups by extractor correctly', () => {
    const results = [
      makeResult({ extractorUsed: 'defuddle', metrics: makeMetric({ f1: 0.9 }) }),
      makeResult({ extractorUsed: 'readability', metrics: makeMetric({ f1: 0.6 }) }),
      makeResult({ extractorUsed: 'defuddle', metrics: makeMetric({ f1: 0.7 }) }),
    ];
    const summary = computeSummary(results);
    expect(summary.byExtractor['defuddle'].count).toBe(2);
    expect(summary.byExtractor['defuddle'].averageF1).toBeCloseTo(0.8);
    expect(summary.byExtractor['readability'].count).toBe(1);
  });

  it('handles empty results array', () => {
    const summary = computeSummary([]);
    expect(summary.totalEntries).toBe(0);
    expect(summary.averageF1).toBe(0);
    expect(summary.averagePrecision).toBe(0);
  });

  it('computes heading and link match rates', () => {
    const results = [
      makeResult({ metrics: makeMetric({ headingCountMatch: true, linkCountMatch: true }) }),
      makeResult({ metrics: makeMetric({ headingCountMatch: false, linkCountMatch: true }) }),
      makeResult({ metrics: makeMetric({ headingCountMatch: true, linkCountMatch: false }) }),
    ];
    const summary = computeSummary(results);
    expect(summary.headingMatchRate).toBeCloseTo(2 / 3);
    expect(summary.linkMatchRate).toBeCloseTo(2 / 3);
  });

  it('computes average extraction time', () => {
    const results = [
      makeResult({ extractionTimeMs: 100 }),
      makeResult({ extractionTimeMs: 200 }),
      makeResult({ extractionTimeMs: 300 }),
    ];
    const summary = computeSummary(results);
    expect(summary.averageExtractionTimeMs).toBeCloseTo(200);
  });
});

describe('generateMarkdownReport', () => {
  it('generates valid markdown with summary section', () => {
    const report: BenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 5000,
      summary: computeSummary([makeResult()]),
      results: [makeResult()],
    };
    const md = generateMarkdownReport(report);
    expect(md).toContain('# Extraction Benchmark Report');
    expect(md).toContain('Precision');
    expect(md).toContain('Recall');
    expect(md).toContain('F1');
    expect(md).toContain('ROUGE-L');
  });

  it('includes category breakdown', () => {
    const report: BenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 5000,
      summary: computeSummary([
        makeResult({ category: 'article' }),
        makeResult({ category: 'docs' }),
      ]),
      results: [makeResult({ category: 'article' }), makeResult({ category: 'docs' })],
    };
    const md = generateMarkdownReport(report);
    expect(md).toContain('article');
    expect(md).toContain('docs');
  });

  it('includes per-result details', () => {
    const report: BenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 5000,
      summary: computeSummary([makeResult({ id: 'specific-id' })]),
      results: [makeResult({ id: 'specific-id' })],
    };
    const md = generateMarkdownReport(report);
    expect(md).toContain('specific-id');
  });

  it('handles empty results', () => {
    const report: BenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 100,
      summary: computeSummary([]),
      results: [],
    };
    const md = generateMarkdownReport(report);
    expect(md).toContain('# Extraction Benchmark Report');
    expect(md).toContain('0');
  });
});

describe('generateJsonReport', () => {
  it('produces valid JSON string', () => {
    const report: BenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 5000,
      summary: computeSummary([makeResult()]),
      results: [makeResult()],
    };
    const json = generateJsonReport(report);
    const parsed = JSON.parse(json);
    expect(parsed.runDate).toBe('2026-04-14T12:00:00Z');
    expect(parsed.summary.totalEntries).toBe(1);
    expect(parsed.results).toHaveLength(1);
  });

  it('handles special characters in URLs', () => {
    const report: BenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 100,
      summary: computeSummary([makeResult({ url: 'https://example.com/path?q=1&b=2' })]),
      results: [makeResult({ url: 'https://example.com/path?q=1&b=2' })],
    };
    const json = generateJsonReport(report);
    const parsed = JSON.parse(json);
    expect(parsed.results[0].url).toBe('https://example.com/path?q=1&b=2');
  });
});
