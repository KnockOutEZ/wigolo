import { describe, it, expect } from 'vitest';
import {
  computePrecisionAtK,
  computeMRR,
  computeDCG,
  computeNDCG,
  computeNDCGAtK,
  computeLatencyPercentiles,
  computeQueryMetrics,
  isUrlRelevant,
} from '../../../../benchmarks/search/metrics.js';
import type { RelevanceJudgment } from '../../../../benchmarks/search/types.js';

const judgments: RelevanceJudgment[] = [
  { queryId: 'q1', url: 'https://a.com', grade: 3 },
  { queryId: 'q1', url: 'https://b.com', grade: 2 },
  { queryId: 'q1', url: 'https://c.com', grade: 1 },
  { queryId: 'q1', url: 'https://d.com', grade: 0 },
];

describe('isUrlRelevant', () => {
  it('returns true for grade >= 1', () => {
    expect(isUrlRelevant('https://a.com', judgments, 'q1')).toBe(true);
    expect(isUrlRelevant('https://b.com', judgments, 'q1')).toBe(true);
    expect(isUrlRelevant('https://c.com', judgments, 'q1')).toBe(true);
  });

  it('returns false for grade 0', () => {
    expect(isUrlRelevant('https://d.com', judgments, 'q1')).toBe(false);
  });

  it('returns false for unjudged URL', () => {
    expect(isUrlRelevant('https://unknown.com', judgments, 'q1')).toBe(false);
  });

  it('returns false for wrong queryId', () => {
    expect(isUrlRelevant('https://a.com', judgments, 'q2')).toBe(false);
  });
});

describe('computePrecisionAtK', () => {
  it('returns 1.0 when all K results are relevant', () => {
    const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
    expect(computePrecisionAtK(urls, judgments, 'q1', 3)).toBe(1);
  });

  it('returns 0 when no results are relevant', () => {
    const urls = ['https://d.com', 'https://unknown.com'];
    expect(computePrecisionAtK(urls, judgments, 'q1', 2)).toBe(0);
  });

  it('returns correct fraction for mixed results', () => {
    const urls = ['https://a.com', 'https://d.com', 'https://b.com'];
    expect(computePrecisionAtK(urls, judgments, 'q1', 3)).toBeCloseTo(2 / 3);
  });

  it('handles K larger than results length', () => {
    const urls = ['https://a.com'];
    expect(computePrecisionAtK(urls, judgments, 'q1', 5)).toBeCloseTo(1 / 5);
  });

  it('returns 0 for empty results', () => {
    expect(computePrecisionAtK([], judgments, 'q1', 3)).toBe(0);
  });

  it('returns 0 for K=0', () => {
    expect(computePrecisionAtK(['https://a.com'], judgments, 'q1', 0)).toBe(0);
  });
});

describe('computeMRR', () => {
  it('returns 1.0 when first result is relevant', () => {
    const urls = ['https://a.com', 'https://d.com'];
    expect(computeMRR(urls, judgments, 'q1')).toBe(1);
  });

  it('returns 0.5 when second result is first relevant', () => {
    const urls = ['https://d.com', 'https://a.com'];
    expect(computeMRR(urls, judgments, 'q1')).toBe(0.5);
  });

  it('returns 0 when no results are relevant', () => {
    const urls = ['https://d.com', 'https://unknown.com'];
    expect(computeMRR(urls, judgments, 'q1')).toBe(0);
  });

  it('returns 0 for empty results', () => {
    expect(computeMRR([], judgments, 'q1')).toBe(0);
  });

  it('returns 1/3 when third result is first relevant', () => {
    const urls = ['https://d.com', 'https://unknown.com', 'https://a.com'];
    expect(computeMRR(urls, judgments, 'q1')).toBeCloseTo(1 / 3);
  });
});

describe('computeDCG', () => {
  it('computes DCG for perfectly ranked results', () => {
    const grades = [3, 2, 1, 0];
    const dcg = computeDCG(grades);
    expect(dcg).toBeCloseTo(4.7618, 2);
  });

  it('returns 0 for all-zero grades', () => {
    expect(computeDCG([0, 0, 0])).toBe(0);
  });

  it('returns 0 for empty grades', () => {
    expect(computeDCG([])).toBe(0);
  });

  it('first position contributes most', () => {
    const dcgFirst = computeDCG([3, 0, 0]);
    const dcgLast = computeDCG([0, 0, 3]);
    expect(dcgFirst).toBeGreaterThan(dcgLast);
  });
});

describe('computeNDCG', () => {
  it('returns 1.0 for perfectly ranked results', () => {
    const rankedUrls = ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'];
    const ndcg = computeNDCG(rankedUrls, judgments, 'q1');
    expect(ndcg).toBeCloseTo(1, 2);
  });

  it('returns less than 1 for suboptimal ranking', () => {
    const rankedUrls = ['https://d.com', 'https://c.com', 'https://b.com', 'https://a.com'];
    const ndcg = computeNDCG(rankedUrls, judgments, 'q1');
    expect(ndcg).toBeLessThan(1);
    expect(ndcg).toBeGreaterThan(0);
  });

  it('returns 0 when all results are irrelevant', () => {
    const rankedUrls = ['https://d.com', 'https://unknown.com'];
    expect(computeNDCG(rankedUrls, judgments, 'q1')).toBe(0);
  });

  it('returns 0 for empty results', () => {
    expect(computeNDCG([], judgments, 'q1')).toBe(0);
  });

  it('returns 0 when no judgments exist for query', () => {
    expect(computeNDCG(['https://a.com'], judgments, 'q-none')).toBe(0);
  });
});

describe('computeNDCGAtK', () => {
  it('computes NDCG considering only top K results', () => {
    const rankedUrls = ['https://a.com', 'https://d.com', 'https://b.com'];
    const ndcgAt1 = computeNDCGAtK(rankedUrls, judgments, 'q1', 1);
    const ndcgAt3 = computeNDCGAtK(rankedUrls, judgments, 'q1', 3);
    expect(ndcgAt1).toBeCloseTo(1);
    expect(ndcgAt3).toBeLessThan(1);
  });

  it('returns 0 for K=0', () => {
    expect(computeNDCGAtK(['https://a.com'], judgments, 'q1', 0)).toBe(0);
  });
});

describe('computeLatencyPercentiles', () => {
  it('computes correct percentiles for sorted latencies', () => {
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
    const p = computeLatencyPercentiles(latencies);
    expect(p.p50).toBe(50);
    expect(p.p95).toBe(95);
    expect(p.p99).toBe(99);
    expect(p.min).toBe(1);
    expect(p.max).toBe(100);
    expect(p.mean).toBeCloseTo(50.5);
  });

  it('handles single value', () => {
    const p = computeLatencyPercentiles([42]);
    expect(p.p50).toBe(42);
    expect(p.p95).toBe(42);
    expect(p.p99).toBe(42);
    expect(p.min).toBe(42);
    expect(p.max).toBe(42);
    expect(p.mean).toBe(42);
  });

  it('returns zeros for empty array', () => {
    const p = computeLatencyPercentiles([]);
    expect(p.p50).toBe(0);
    expect(p.mean).toBe(0);
  });

  it('sorts unsorted input correctly', () => {
    const latencies = [100, 1, 50, 99, 95];
    const p = computeLatencyPercentiles(latencies);
    expect(p.min).toBe(1);
    expect(p.max).toBe(100);
  });
});

describe('computeQueryMetrics', () => {
  it('computes all metric fields for valid input', () => {
    const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
    const result = computeQueryMetrics('q1', 'test query', 'docs', urls, judgments, 50);

    expect(result.queryId).toBe('q1');
    expect(result.query).toBe('test query');
    expect(result.category).toBe('docs');
    expect(result.precisionAt3).toBeGreaterThan(0);
    expect(result.mrr).toBeGreaterThan(0);
    expect(result.ndcg).toBeGreaterThan(0);
    expect(result.hasRelevantResult).toBe(true);
    expect(result.resultCount).toBe(3);
    expect(result.latencyMs).toBe(50);
  });

  it('handles no results', () => {
    const result = computeQueryMetrics('q1', 'test query', 'docs', [], judgments, 10);
    expect(result.precisionAt3).toBe(0);
    expect(result.mrr).toBe(0);
    expect(result.ndcg).toBe(0);
    expect(result.hasRelevantResult).toBe(false);
  });
});
