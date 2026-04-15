import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../src/logger.js';
import { extractContent } from '../../src/extraction/pipeline.js';
import { computeMetrics } from './metrics.js';
import { computeSummary, generateMarkdownReport, generateJsonReport } from './report.js';
import type {
  Manifest,
  ManifestEntry,
  ExtractionBenchmarkResult,
  BenchmarkReport,
  RunnerOptions,
} from './types.js';

const log = createLogger('extract');

export function loadManifest(manifestPath: string): Manifest {
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      throw new Error('Manifest missing "entries" array');
    }
    if (parsed.entries.length === 0) {
      throw new Error('Manifest has empty entries array');
    }

    return parsed as Manifest;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in manifest: ${err.message}`);
    }
    throw err;
  }
}

export function loadFixtureHtml(fixturesDir: string, relativePath: string): string {
  try {
    const fullPath = join(fixturesDir, relativePath);
    return readFileSync(fullPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to load HTML fixture "${relativePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function loadGoldenMarkdown(goldenDir: string, relativePath: string): string {
  try {
    const fullPath = join(goldenDir, relativePath);
    return readFileSync(fullPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to load golden markdown "${relativePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function filterManifestEntries(
  entries: ManifestEntry[],
  filter?: string,
): ManifestEntry[] {
  try {
    if (!filter) return entries;

    const lower = filter.toLowerCase();
    return entries.filter(entry => {
      if (entry.category.toLowerCase() === lower) return true;
      if (entry.id.toLowerCase().includes(lower)) return true;
      if (entry.tags?.some(t => t.toLowerCase() === lower)) return true;
      return false;
    });
  } catch (err) {
    log.warn('filterManifestEntries failed', { error: String(err) });
    return entries;
  }
}

export async function runSingleBenchmark(
  entry: ManifestEntry,
  html: string,
  golden: string,
): Promise<ExtractionBenchmarkResult> {
  const startTime = Date.now();

  try {
    const result = await extractContent(html, entry.url);
    const extractionTimeMs = Date.now() - startTime;

    const metrics = computeMetrics(result.markdown, golden);

    const extractorMatch = entry.expectedExtractor
      ? result.extractor === entry.expectedExtractor
      : true;

    return {
      id: entry.id,
      url: entry.url,
      category: entry.category,
      extractorUsed: result.extractor,
      expectedExtractor: entry.expectedExtractor,
      extractorMatch,
      metrics,
      extractionTimeMs,
      markdownLength: result.markdown.length,
      goldenLength: golden.length,
    };
  } catch (err) {
    const extractionTimeMs = Date.now() - startTime;
    log.error('benchmark entry failed', { id: entry.id, error: String(err) });

    return {
      id: entry.id,
      url: entry.url,
      category: entry.category,
      extractorUsed: 'unknown',
      expectedExtractor: entry.expectedExtractor,
      extractorMatch: false,
      metrics: {
        precision: 0,
        recall: 0,
        f1: 0,
        rougeL: 0,
        headingCountMatch: false,
        headingCountExpected: 0,
        headingCountActual: 0,
        linkCountMatch: false,
        linkCountExpected: 0,
        linkCountActual: 0,
      },
      extractionTimeMs,
      markdownLength: 0,
      goldenLength: golden.length,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runBenchmark(options: RunnerOptions): Promise<BenchmarkReport> {
  const startTime = Date.now();

  if (!existsSync(options.manifestPath)) {
    throw new Error(`Manifest file not found: ${options.manifestPath}`);
  }

  const manifest = loadManifest(options.manifestPath);
  const entries = filterManifestEntries(manifest.entries, options.filter);

  if (entries.length === 0) {
    throw new Error(`No entries match filter "${options.filter}"`);
  }

  log.info('starting extraction benchmark', {
    totalEntries: entries.length,
    filter: options.filter ?? 'none',
  });

  const concurrency = options.concurrency ?? 1;
  const results: ExtractionBenchmarkResult[] = [];

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        try {
          const html = loadFixtureHtml(options.fixturesDir, entry.htmlFixturePath);
          const golden = loadGoldenMarkdown(options.goldenDir, entry.goldenPath);
          return await runSingleBenchmark(entry, html, golden);
        } catch (err) {
          log.error('failed to load fixtures for entry', { id: entry.id, error: String(err) });
          return {
            id: entry.id,
            url: entry.url,
            category: entry.category,
            extractorUsed: 'unknown',
            expectedExtractor: entry.expectedExtractor,
            extractorMatch: false,
            metrics: {
              precision: 0, recall: 0, f1: 0, rougeL: 0,
              headingCountMatch: false, headingCountExpected: 0, headingCountActual: 0,
              linkCountMatch: false, linkCountExpected: 0, linkCountActual: 0,
            },
            extractionTimeMs: 0,
            markdownLength: 0,
            goldenLength: 0,
            error: err instanceof Error ? err.message : String(err),
          } as ExtractionBenchmarkResult;
        }
      }),
    );

    results.push(...batchResults);
  }

  const durationMs = Date.now() - startTime;
  const summary = computeSummary(results);

  const report: BenchmarkReport = {
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
      join(options.outputDir, 'extraction-benchmark.json'),
      generateJsonReport(report),
      'utf-8',
    );

    writeFileSync(
      join(options.outputDir, 'extraction-benchmark.md'),
      generateMarkdownReport(report),
      'utf-8',
    );

    log.info('benchmark complete', {
      totalEntries: summary.totalEntries,
      successful: summary.successfulEntries,
      failed: summary.failedEntries,
      avgF1: summary.averageF1.toFixed(3),
      durationMs,
    });
  } catch (err) {
    log.error('failed to write benchmark output', { error: String(err) });
  }

  return report;
}
