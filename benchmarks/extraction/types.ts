export interface ManifestEntry {
  id: string;
  url: string;
  category: 'article' | 'docs' | 'github' | 'stackoverflow' | 'spa' | 'table-heavy' | 'code-heavy';
  htmlFixturePath: string;
  goldenPath: string;
  expectedExtractor?: string;
  tags?: string[];
  notes?: string;
}

export interface Manifest {
  version: string;
  created: string;
  entries: ManifestEntry[];
}

export interface MetricResult {
  precision: number;
  recall: number;
  f1: number;
  rougeL: number;
  headingCountMatch: boolean;
  headingCountExpected: number;
  headingCountActual: number;
  linkCountMatch: boolean;
  linkCountExpected: number;
  linkCountActual: number;
}

export interface ExtractionBenchmarkResult {
  id: string;
  url: string;
  category: string;
  extractorUsed: string;
  expectedExtractor?: string;
  extractorMatch: boolean;
  metrics: MetricResult;
  extractionTimeMs: number;
  markdownLength: number;
  goldenLength: number;
  error?: string;
}

export interface BenchmarkSummary {
  totalEntries: number;
  successfulEntries: number;
  failedEntries: number;
  averagePrecision: number;
  averageRecall: number;
  averageF1: number;
  averageRougeL: number;
  averageExtractionTimeMs: number;
  extractorMatchRate: number;
  headingMatchRate: number;
  linkMatchRate: number;
  byCategory: Record<string, CategorySummary>;
  byExtractor: Record<string, ExtractorSummary>;
}

export interface CategorySummary {
  count: number;
  averageF1: number;
  averageRougeL: number;
  averagePrecision: number;
  averageRecall: number;
}

export interface ExtractorSummary {
  count: number;
  averageF1: number;
  averageRougeL: number;
}

export interface BenchmarkReport {
  runDate: string;
  durationMs: number;
  summary: BenchmarkSummary;
  results: ExtractionBenchmarkResult[];
}

export interface RunnerOptions {
  manifestPath: string;
  fixturesDir: string;
  goldenDir: string;
  outputDir: string;
  concurrency?: number;
  filter?: string;
  verbose?: boolean;
}
