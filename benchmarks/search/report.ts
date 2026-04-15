import { createLogger } from '../../src/logger.js';
import { computeLatencyPercentiles } from './metrics.js';
import type {
  QueryMetricResult,
  SearchBenchmarkSummary,
  SearchBenchmarkReport,
  CategorySearchSummary,
} from './types.js';

const log = createLogger('search');

export function computeSearchSummary(results: QueryMetricResult[]): SearchBenchmarkSummary {
  try {
    if (results.length === 0) {
      return {
        totalQueries: 0,
        successfulQueries: 0,
        failedQueries: 0,
        averagePrecisionAt3: 0,
        averagePrecisionAt5: 0,
        averagePrecisionAt10: 0,
        meanReciprocalRank: 0,
        averageNdcg: 0,
        averageNdcgAt5: 0,
        averageNdcgAt10: 0,
        queryCoverage: 0,
        latency: { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 },
        byCategory: {},
      };
    }

    const successful = results.filter(r => !r.error);
    const failed = results.filter(r => !!r.error);
    const n = successful.length || 1;

    const sumP3 = successful.reduce((s, r) => s + r.precisionAt3, 0);
    const sumP5 = successful.reduce((s, r) => s + r.precisionAt5, 0);
    const sumP10 = successful.reduce((s, r) => s + r.precisionAt10, 0);
    const sumMrr = successful.reduce((s, r) => s + r.mrr, 0);
    const sumNdcg = successful.reduce((s, r) => s + r.ndcg, 0);
    const sumNdcg5 = successful.reduce((s, r) => s + r.ndcgAt5, 0);
    const sumNdcg10 = successful.reduce((s, r) => s + r.ndcgAt10, 0);
    const coverageCount = results.filter(r => r.hasRelevantResult).length;

    const latencies = results.map(r => r.latencyMs);
    const latency = computeLatencyPercentiles(latencies);

    const byCategory: Record<string, CategorySearchSummary> = {};
    for (const r of successful) {
      if (!byCategory[r.category]) {
        byCategory[r.category] = {
          count: 0,
          averagePrecisionAt5: 0,
          averageMrr: 0,
          averageNdcg: 0,
          coverage: 0,
        };
      }
      const cat = byCategory[r.category];
      cat.count++;
      cat.averagePrecisionAt5 += r.precisionAt5;
      cat.averageMrr += r.mrr;
      cat.averageNdcg += r.ndcg;
      if (r.hasRelevantResult) cat.coverage++;
    }
    for (const key of Object.keys(byCategory)) {
      const cat = byCategory[key];
      cat.averagePrecisionAt5 /= cat.count;
      cat.averageMrr /= cat.count;
      cat.averageNdcg /= cat.count;
      cat.coverage /= cat.count;
    }

    return {
      totalQueries: results.length,
      successfulQueries: successful.length,
      failedQueries: failed.length,
      averagePrecisionAt3: sumP3 / n,
      averagePrecisionAt5: sumP5 / n,
      averagePrecisionAt10: sumP10 / n,
      meanReciprocalRank: sumMrr / n,
      averageNdcg: sumNdcg / n,
      averageNdcgAt5: sumNdcg5 / n,
      averageNdcgAt10: sumNdcg10 / n,
      queryCoverage: coverageCount / results.length,
      latency,
      byCategory,
    };
  } catch (err) {
    log.error('computeSearchSummary failed', { error: String(err) });
    return {
      totalQueries: results.length,
      successfulQueries: 0,
      failedQueries: results.length,
      averagePrecisionAt3: 0,
      averagePrecisionAt5: 0,
      averagePrecisionAt10: 0,
      meanReciprocalRank: 0,
      averageNdcg: 0,
      averageNdcgAt5: 0,
      averageNdcgAt10: 0,
      queryCoverage: 0,
      latency: { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 },
      byCategory: {},
    };
  }
}

export function generateSearchMarkdownReport(report: SearchBenchmarkReport): string {
  try {
    const { summary, results } = report;
    const lines: string[] = [];

    lines.push('# Search Benchmark Report');
    lines.push('');
    lines.push(`**Run Date:** ${report.runDate}`);
    lines.push(`**Duration:** ${(report.durationMs / 1000).toFixed(1)}s`);
    lines.push(`**Total Queries:** ${summary.totalQueries}`);
    lines.push(`**Successful:** ${summary.successfulQueries} | **Failed:** ${summary.failedQueries}`);
    lines.push('');

    lines.push('## Overall Metrics');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Precision@3 | ${(summary.averagePrecisionAt3 * 100).toFixed(1)}% |`);
    lines.push(`| Precision@5 | ${(summary.averagePrecisionAt5 * 100).toFixed(1)}% |`);
    lines.push(`| Precision@10 | ${(summary.averagePrecisionAt10 * 100).toFixed(1)}% |`);
    lines.push(`| MRR | ${summary.meanReciprocalRank.toFixed(3)} |`);
    lines.push(`| NDCG | ${(summary.averageNdcg * 100).toFixed(1)}% |`);
    lines.push(`| NDCG@5 | ${(summary.averageNdcgAt5 * 100).toFixed(1)}% |`);
    lines.push(`| NDCG@10 | ${(summary.averageNdcgAt10 * 100).toFixed(1)}% |`);
    lines.push(`| Coverage | ${(summary.queryCoverage * 100).toFixed(1)}% |`);
    lines.push('');

    lines.push('## Latency');
    lines.push('');
    lines.push('| Percentile | Value |');
    lines.push('|------------|-------|');
    lines.push(`| p50 | ${summary.latency.p50}ms |`);
    lines.push(`| p95 | ${summary.latency.p95}ms |`);
    lines.push(`| p99 | ${summary.latency.p99}ms |`);
    lines.push(`| Mean | ${summary.latency.mean.toFixed(0)}ms |`);
    lines.push(`| Min | ${summary.latency.min}ms |`);
    lines.push(`| Max | ${summary.latency.max}ms |`);
    lines.push('');

    const categories = Object.keys(summary.byCategory);
    if (categories.length > 0) {
      lines.push('## By Category');
      lines.push('');
      lines.push('| Category | Count | P@5 | MRR | NDCG | Coverage |');
      lines.push('|----------|-------|-----|-----|------|----------|');
      for (const cat of categories) {
        const c = summary.byCategory[cat];
        lines.push(`| ${cat} | ${c.count} | ${(c.averagePrecisionAt5 * 100).toFixed(1)}% | ${c.averageMrr.toFixed(3)} | ${(c.averageNdcg * 100).toFixed(1)}% | ${(c.coverage * 100).toFixed(0)}% |`);
      }
      lines.push('');
    }

    lines.push('## Detailed Results');
    lines.push('');
    lines.push('| Query ID | Category | P@5 | MRR | NDCG | Results | Latency |');
    lines.push('|----------|----------|-----|-----|------|---------|---------|');
    for (const r of results) {
      const errMark = r.error ? ' ERR' : '';
      lines.push(`| ${r.queryId}${errMark} | ${r.category} | ${(r.precisionAt5 * 100).toFixed(0)}% | ${r.mrr.toFixed(2)} | ${(r.ndcg * 100).toFixed(0)}% | ${r.resultCount} | ${r.latencyMs}ms |`);
    }
    lines.push('');

    return lines.join('\n');
  } catch (err) {
    log.error('generateSearchMarkdownReport failed', { error: String(err) });
    return '# Search Benchmark Report\n\nError generating report.';
  }
}

export function generateSearchJsonReport(report: SearchBenchmarkReport): string {
  try {
    return JSON.stringify(report, null, 2);
  } catch (err) {
    log.error('generateSearchJsonReport failed', { error: String(err) });
    return JSON.stringify({ error: String(err) });
  }
}
