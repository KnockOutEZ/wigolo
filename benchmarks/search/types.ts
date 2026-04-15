export type QueryCategory = 'docs' | 'error' | 'conceptual' | 'code' | 'multi-query';

export interface BenchmarkQuery {
  id: string;
  query: string;
  category: QueryCategory;
  expectedDomains?: string[];
  tags?: string[];
  notes?: string;
}

export interface RelevanceJudgment {
  queryId: string;
  url: string;
  grade: 0 | 1 | 2 | 3;
}

export interface RelevanceMap {
  judgments: RelevanceJudgment[];
}

export interface PrerecordedResult {
  title: string;
  url: string;
  snippet: string;
  relevance_score: number;
  engine: string;
}

export interface PrerecordedResponse {
  queryId: string;
  results: PrerecordedResult[];
}

export interface QueryMetricResult {
  queryId: string;
  query: string;
  category: QueryCategory;
  precisionAt3: number;
  precisionAt5: number;
  precisionAt10: number;
  mrr: number;
  ndcg: number;
  ndcgAt5: number;
  ndcgAt10: number;
  hasRelevantResult: boolean;
  resultCount: number;
  latencyMs: number;
  error?: string;
}

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

export interface SearchBenchmarkSummary {
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  averagePrecisionAt3: number;
  averagePrecisionAt5: number;
  averagePrecisionAt10: number;
  meanReciprocalRank: number;
  averageNdcg: number;
  averageNdcgAt5: number;
  averageNdcgAt10: number;
  queryCoverage: number;
  latency: LatencyPercentiles;
  byCategory: Record<string, CategorySearchSummary>;
}

export interface CategorySearchSummary {
  count: number;
  averagePrecisionAt5: number;
  averageMrr: number;
  averageNdcg: number;
  coverage: number;
}

export interface SearchBenchmarkReport {
  runDate: string;
  durationMs: number;
  summary: SearchBenchmarkSummary;
  results: QueryMetricResult[];
}

export interface SearchRunnerOptions {
  queriesPath: string;
  relevancePath: string;
  responsesDir: string;
  outputDir: string;
  filter?: string;
  verbose?: boolean;
}
