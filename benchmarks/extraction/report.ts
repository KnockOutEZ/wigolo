import { createLogger } from '../../src/logger.js';
import type {
  ExtractionBenchmarkResult,
  BenchmarkSummary,
  BenchmarkReport,
  CategorySummary,
  ExtractorSummary,
} from './types.js';

const log = createLogger('extract');

export function computeSummary(results: ExtractionBenchmarkResult[]): BenchmarkSummary {
  try {
    if (results.length === 0) {
      return {
        totalEntries: 0,
        successfulEntries: 0,
        failedEntries: 0,
        averagePrecision: 0,
        averageRecall: 0,
        averageF1: 0,
        averageRougeL: 0,
        averageExtractionTimeMs: 0,
        extractorMatchRate: 0,
        headingMatchRate: 0,
        linkMatchRate: 0,
        byCategory: {},
        byExtractor: {},
      };
    }

    const successful = results.filter(r => !r.error);
    const failed = results.filter(r => !!r.error);

    const sumPrecision = successful.reduce((s, r) => s + r.metrics.precision, 0);
    const sumRecall = successful.reduce((s, r) => s + r.metrics.recall, 0);
    const sumF1 = successful.reduce((s, r) => s + r.metrics.f1, 0);
    const sumRougeL = successful.reduce((s, r) => s + r.metrics.rougeL, 0);
    const sumTime = results.reduce((s, r) => s + r.extractionTimeMs, 0);
    const extractorMatches = results.filter(r => r.extractorMatch).length;
    const headingMatches = results.filter(r => r.metrics.headingCountMatch).length;
    const linkMatches = results.filter(r => r.metrics.linkCountMatch).length;

    const n = successful.length || 1;

    const byCategory: Record<string, CategorySummary> = {};
    for (const r of successful) {
      if (!byCategory[r.category]) {
        byCategory[r.category] = { count: 0, averageF1: 0, averageRougeL: 0, averagePrecision: 0, averageRecall: 0 };
      }
      byCategory[r.category].count++;
      byCategory[r.category].averageF1 += r.metrics.f1;
      byCategory[r.category].averageRougeL += r.metrics.rougeL;
      byCategory[r.category].averagePrecision += r.metrics.precision;
      byCategory[r.category].averageRecall += r.metrics.recall;
    }
    for (const cat of Object.keys(byCategory)) {
      const c = byCategory[cat];
      c.averageF1 /= c.count;
      c.averageRougeL /= c.count;
      c.averagePrecision /= c.count;
      c.averageRecall /= c.count;
    }

    const byExtractor: Record<string, ExtractorSummary> = {};
    for (const r of successful) {
      if (!byExtractor[r.extractorUsed]) {
        byExtractor[r.extractorUsed] = { count: 0, averageF1: 0, averageRougeL: 0 };
      }
      byExtractor[r.extractorUsed].count++;
      byExtractor[r.extractorUsed].averageF1 += r.metrics.f1;
      byExtractor[r.extractorUsed].averageRougeL += r.metrics.rougeL;
    }
    for (const ext of Object.keys(byExtractor)) {
      const e = byExtractor[ext];
      e.averageF1 /= e.count;
      e.averageRougeL /= e.count;
    }

    return {
      totalEntries: results.length,
      successfulEntries: successful.length,
      failedEntries: failed.length,
      averagePrecision: sumPrecision / n,
      averageRecall: sumRecall / n,
      averageF1: sumF1 / n,
      averageRougeL: sumRougeL / n,
      averageExtractionTimeMs: sumTime / results.length,
      extractorMatchRate: extractorMatches / results.length,
      headingMatchRate: headingMatches / results.length,
      linkMatchRate: linkMatches / results.length,
      byCategory,
      byExtractor,
    };
  } catch (err) {
    log.error('computeSummary failed', { error: String(err) });
    return {
      totalEntries: results.length,
      successfulEntries: 0,
      failedEntries: results.length,
      averagePrecision: 0,
      averageRecall: 0,
      averageF1: 0,
      averageRougeL: 0,
      averageExtractionTimeMs: 0,
      extractorMatchRate: 0,
      headingMatchRate: 0,
      linkMatchRate: 0,
      byCategory: {},
      byExtractor: {},
    };
  }
}

export function generateMarkdownReport(report: BenchmarkReport): string {
  try {
    const { summary, results } = report;
    const lines: string[] = [];

    lines.push('# Extraction Benchmark Report');
    lines.push('');
    lines.push(`**Run Date:** ${report.runDate}`);
    lines.push(`**Duration:** ${(report.durationMs / 1000).toFixed(1)}s`);
    lines.push(`**Total Entries:** ${summary.totalEntries}`);
    lines.push(`**Successful:** ${summary.successfulEntries} | **Failed:** ${summary.failedEntries}`);
    lines.push('');

    lines.push('## Overall Metrics');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Precision | ${(summary.averagePrecision * 100).toFixed(1)}% |`);
    lines.push(`| Recall | ${(summary.averageRecall * 100).toFixed(1)}% |`);
    lines.push(`| F1 | ${(summary.averageF1 * 100).toFixed(1)}% |`);
    lines.push(`| ROUGE-L | ${(summary.averageRougeL * 100).toFixed(1)}% |`);
    lines.push(`| Extractor Match Rate | ${(summary.extractorMatchRate * 100).toFixed(1)}% |`);
    lines.push(`| Heading Match Rate | ${(summary.headingMatchRate * 100).toFixed(1)}% |`);
    lines.push(`| Link Match Rate | ${(summary.linkMatchRate * 100).toFixed(1)}% |`);
    lines.push(`| Avg Extraction Time | ${summary.averageExtractionTimeMs.toFixed(0)}ms |`);
    lines.push('');

    const categories = Object.keys(summary.byCategory);
    if (categories.length > 0) {
      lines.push('## By Category');
      lines.push('');
      lines.push('| Category | Count | Precision | Recall | F1 | ROUGE-L |');
      lines.push('|----------|-------|-----------|--------|-----|---------|');
      for (const cat of categories) {
        const c = summary.byCategory[cat];
        lines.push(`| ${cat} | ${c.count} | ${(c.averagePrecision * 100).toFixed(1)}% | ${(c.averageRecall * 100).toFixed(1)}% | ${(c.averageF1 * 100).toFixed(1)}% | ${(c.averageRougeL * 100).toFixed(1)}% |`);
      }
      lines.push('');
    }

    const extractors = Object.keys(summary.byExtractor);
    if (extractors.length > 0) {
      lines.push('## By Extractor');
      lines.push('');
      lines.push('| Extractor | Count | F1 | ROUGE-L |');
      lines.push('|-----------|-------|----|---------|');
      for (const ext of extractors) {
        const e = summary.byExtractor[ext];
        lines.push(`| ${ext} | ${e.count} | ${(e.averageF1 * 100).toFixed(1)}% | ${(e.averageRougeL * 100).toFixed(1)}% |`);
      }
      lines.push('');
    }

    lines.push('## Detailed Results');
    lines.push('');
    lines.push('| ID | Category | Extractor | F1 | ROUGE-L | Headings | Links | Time |');
    lines.push('|----|----------|-----------|-----|---------|----------|-------|------|');
    for (const r of results) {
      const hMatch = r.metrics.headingCountMatch ? 'ok' : `${r.metrics.headingCountActual}/${r.metrics.headingCountExpected}`;
      const lMatch = r.metrics.linkCountMatch ? 'ok' : `${r.metrics.linkCountActual}/${r.metrics.linkCountExpected}`;
      const errMark = r.error ? ' ERR' : '';
      lines.push(`| ${r.id}${errMark} | ${r.category} | ${r.extractorUsed} | ${(r.metrics.f1 * 100).toFixed(1)}% | ${(r.metrics.rougeL * 100).toFixed(1)}% | ${hMatch} | ${lMatch} | ${r.extractionTimeMs}ms |`);
    }
    lines.push('');

    return lines.join('\n');
  } catch (err) {
    log.error('generateMarkdownReport failed', { error: String(err) });
    return '# Extraction Benchmark Report\n\nError generating report.';
  }
}

export function generateJsonReport(report: BenchmarkReport): string {
  try {
    return JSON.stringify(report, null, 2);
  } catch (err) {
    log.error('generateJsonReport failed', { error: String(err) });
    return JSON.stringify({ error: String(err) });
  }
}
