import { createLogger } from '../../src/logger.js';
import type {
  RelevanceJudgment,
  QueryMetricResult,
  QueryCategory,
  LatencyPercentiles,
} from './types.js';

const log = createLogger('search');

export function getGrade(url: string, judgments: RelevanceJudgment[], queryId: string): number {
  try {
    const judgment = judgments.find(j => j.queryId === queryId && j.url === url);
    return judgment ? judgment.grade : 0;
  } catch (err) {
    log.warn('getGrade failed', { error: String(err) });
    return 0;
  }
}

export function isUrlRelevant(url: string, judgments: RelevanceJudgment[], queryId: string): boolean {
  return getGrade(url, judgments, queryId) >= 1;
}

export function computePrecisionAtK(
  rankedUrls: string[],
  judgments: RelevanceJudgment[],
  queryId: string,
  k: number,
): number {
  try {
    if (k <= 0 || rankedUrls.length === 0) return 0;

    const topK = rankedUrls.slice(0, k);
    const relevantCount = topK.filter(url => isUrlRelevant(url, judgments, queryId)).length;
    return relevantCount / k;
  } catch (err) {
    log.warn('computePrecisionAtK failed', { error: String(err) });
    return 0;
  }
}

export function computeMRR(
  rankedUrls: string[],
  judgments: RelevanceJudgment[],
  queryId: string,
): number {
  try {
    if (rankedUrls.length === 0) return 0;

    for (let i = 0; i < rankedUrls.length; i++) {
      if (isUrlRelevant(rankedUrls[i], judgments, queryId)) {
        return 1 / (i + 1);
      }
    }
    return 0;
  } catch (err) {
    log.warn('computeMRR failed', { error: String(err) });
    return 0;
  }
}

export function computeDCG(grades: number[]): number {
  try {
    if (grades.length === 0) return 0;

    let dcg = 0;
    for (let i = 0; i < grades.length; i++) {
      if (grades[i] === 0) continue;
      dcg += grades[i] / Math.log2(i + 2);
    }
    return dcg;
  } catch (err) {
    log.warn('computeDCG failed', { error: String(err) });
    return 0;
  }
}

export function computeNDCG(
  rankedUrls: string[],
  judgments: RelevanceJudgment[],
  queryId: string,
): number {
  try {
    if (rankedUrls.length === 0) return 0;

    const queryJudgments = judgments.filter(j => j.queryId === queryId);
    if (queryJudgments.length === 0) return 0;

    const actualGrades = rankedUrls.map(url => getGrade(url, judgments, queryId));
    const actualDCG = computeDCG(actualGrades);

    if (actualDCG === 0) return 0;

    const idealGrades = queryJudgments
      .map(j => j.grade)
      .sort((a, b) => b - a)
      .slice(0, rankedUrls.length);
    const idealDCG = computeDCG(idealGrades);

    if (idealDCG === 0) return 0;

    return actualDCG / idealDCG;
  } catch (err) {
    log.warn('computeNDCG failed', { error: String(err) });
    return 0;
  }
}

export function computeNDCGAtK(
  rankedUrls: string[],
  judgments: RelevanceJudgment[],
  queryId: string,
  k: number,
): number {
  try {
    if (k <= 0) return 0;
    return computeNDCG(rankedUrls.slice(0, k), judgments, queryId);
  } catch (err) {
    log.warn('computeNDCGAtK failed', { error: String(err) });
    return 0;
  }
}

export function computeLatencyPercentiles(latencies: number[]): LatencyPercentiles {
  try {
    if (latencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 };
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const n = sorted.length;

    const percentile = (p: number): number => {
      const idx = Math.ceil((p / 100) * n) - 1;
      return sorted[Math.max(0, Math.min(idx, n - 1))];
    };

    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      mean: sum / n,
      min: sorted[0],
      max: sorted[n - 1],
    };
  } catch (err) {
    log.warn('computeLatencyPercentiles failed', { error: String(err) });
    return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 };
  }
}

export function computeQueryMetrics(
  queryId: string,
  query: string,
  category: QueryCategory,
  rankedUrls: string[],
  judgments: RelevanceJudgment[],
  latencyMs: number,
): QueryMetricResult {
  try {
    const precisionAt3 = computePrecisionAtK(rankedUrls, judgments, queryId, 3);
    const precisionAt5 = computePrecisionAtK(rankedUrls, judgments, queryId, 5);
    const precisionAt10 = computePrecisionAtK(rankedUrls, judgments, queryId, 10);
    const mrr = computeMRR(rankedUrls, judgments, queryId);
    const ndcg = computeNDCG(rankedUrls, judgments, queryId);
    const ndcgAt5 = computeNDCGAtK(rankedUrls, judgments, queryId, 5);
    const ndcgAt10 = computeNDCGAtK(rankedUrls, judgments, queryId, 10);
    const hasRelevantResult = rankedUrls.some(url => isUrlRelevant(url, judgments, queryId));

    return {
      queryId,
      query,
      category,
      precisionAt3,
      precisionAt5,
      precisionAt10,
      mrr,
      ndcg,
      ndcgAt5,
      ndcgAt10,
      hasRelevantResult,
      resultCount: rankedUrls.length,
      latencyMs,
    };
  } catch (err) {
    log.error('computeQueryMetrics failed', { queryId, error: String(err) });
    return {
      queryId,
      query,
      category,
      precisionAt3: 0,
      precisionAt5: 0,
      precisionAt10: 0,
      mrr: 0,
      ndcg: 0,
      ndcgAt5: 0,
      ndcgAt10: 0,
      hasRelevantResult: false,
      resultCount: 0,
      latencyMs,
      error: String(err),
    };
  }
}
