import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../src/logger.js';
import { computeQueryMetrics } from './metrics.js';
import { computeSearchSummary, generateSearchMarkdownReport, generateSearchJsonReport } from './report.js';
import { loadPrerecordedResponses, MockSearchEngine } from './mock-engine.js';
import type {
  BenchmarkQuery,
  RelevanceJudgment,
  QueryMetricResult,
  SearchBenchmarkReport,
  SearchRunnerOptions,
} from './types.js';

const log = createLogger('search');

export function loadQueries(queriesPath: string): BenchmarkQuery[] {
  try {
    const raw = readFileSync(queriesPath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!parsed.queries || !Array.isArray(parsed.queries)) {
      throw new Error('Queries file missing "queries" array');
    }
    if (parsed.queries.length === 0) {
      throw new Error('Queries file has empty queries array');
    }

    return parsed.queries as BenchmarkQuery[];
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in queries file: ${err.message}`);
    }
    throw err;
  }
}

export function loadRelevanceJudgments(relevancePath: string): RelevanceJudgment[] {
  try {
    const raw = readFileSync(relevancePath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!parsed.judgments || !Array.isArray(parsed.judgments)) {
      throw new Error('Relevance file missing "judgments" array');
    }

    return parsed.judgments as RelevanceJudgment[];
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in relevance file: ${err.message}`);
    }
    throw err;
  }
}

export function filterQueries(
  queries: BenchmarkQuery[],
  filter?: string,
): BenchmarkQuery[] {
  try {
    if (!filter) return queries;

    const lower = filter.toLowerCase();
    return queries.filter(q => {
      if (q.category.toLowerCase() === lower) return true;
      if (q.id.toLowerCase().includes(lower)) return true;
      if (q.tags?.some(t => t.toLowerCase() === lower)) return true;
      return false;
    });
  } catch (err) {
    log.warn('filterQueries failed', { error: String(err) });
    return queries;
  }
}

export async function runSingleQueryBenchmark(
  query: BenchmarkQuery,
  searchFn: (q: string) => Promise<Array<{ title: string; url: string; snippet: string; relevance_score: number }>>,
  judgments: RelevanceJudgment[],
): Promise<QueryMetricResult> {
  const startTime = Date.now();

  try {
    const results = await searchFn(query.query);
    const latencyMs = Date.now() - startTime;

    const rankedUrls = results.map(r => r.url);

    return computeQueryMetrics(
      query.id,
      query.query,
      query.category,
      rankedUrls,
      judgments,
      latencyMs,
    );
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    log.error('query benchmark failed', { queryId: query.id, error: String(err) });

    return {
      queryId: query.id,
      query: query.query,
      category: query.category,
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
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runSearchBenchmark(options: SearchRunnerOptions): Promise<SearchBenchmarkReport> {
  const startTime = Date.now();

  if (!existsSync(options.queriesPath)) {
    throw new Error(`Queries file not found: ${options.queriesPath}`);
  }
  if (!existsSync(options.relevancePath)) {
    throw new Error(`Relevance file not found: ${options.relevancePath}`);
  }

  const queries = loadQueries(options.queriesPath);
  const judgments = loadRelevanceJudgments(options.relevancePath);
  const responses = loadPrerecordedResponses(options.responsesDir);

  const filtered = filterQueries(queries, options.filter);
  if (filtered.length === 0) {
    throw new Error(`No queries match filter "${options.filter}"`);
  }

  log.info('starting search benchmark', {
    totalQueries: filtered.length,
    totalJudgments: judgments.length,
    totalResponses: responses.size,
  });

  const results: QueryMetricResult[] = [];

  for (const query of filtered) {
    const engine = new MockSearchEngine(responses, query.id);

    const result = await runSingleQueryBenchmark(
      query,
      async (q) => {
        const raw = await engine.search(q, { maxResults: 10 });
        return raw.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          relevance_score: r.relevance_score,
        }));
      },
      judgments,
    );

    results.push(result);

    if (options.verbose) {
      log.info('query benchmark complete', {
        queryId: query.id,
        mrr: result.mrr.toFixed(3),
        ndcg: result.ndcg.toFixed(3),
        latencyMs: result.latencyMs,
      });
    }
  }

  const durationMs = Date.now() - startTime;
  const summary = computeSearchSummary(results);

  const report: SearchBenchmarkReport = {
    runDate: new Date().toISOString(),
    durationMs,
    summary,
    results,
  };

  try {
    if (!existsSync(options.outputDir)) {
      mkdirSync(options.outputDir, { recursive: true });
    }

    writeFileSync(
      join(options.outputDir, 'search-benchmark.json'),
      generateSearchJsonReport(report),
      'utf-8',
    );

    writeFileSync(
      join(options.outputDir, 'search-benchmark.md'),
      generateSearchMarkdownReport(report),
      'utf-8',
    );

    log.info('search benchmark complete', {
      totalQueries: summary.totalQueries,
      mrr: summary.meanReciprocalRank.toFixed(3),
      ndcg: summary.averageNdcg.toFixed(3),
      coverage: (summary.queryCoverage * 100).toFixed(1) + '%',
      durationMs,
    });
  } catch (err) {
    log.error('failed to write search benchmark output', { error: String(err) });
  }

  return report;
}
