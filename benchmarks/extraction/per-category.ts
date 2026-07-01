#!/usr/bin/env node
/**
 * Per-category extraction quality bench.
 *
 * Runs each manifest fixture through BOTH the legacy ensemble pipeline
 * (extractContent) and the v1 routed extractor (via the factory), then
 * reports per-category F1 deltas vs the golden markdown.
 *
 * Gated on RUN_EXTRACT_BENCH=1 (sandbox-friendly skip when unset).
 *
 * Run on dev host:
 *   RUN_EXTRACT_BENCH=1 npx tsx benchmarks/extraction/per-category.ts
 *
 * Output: benchmarks/extraction/output/per-category.json
 *
 * Quality gates:
 *   Aggregate F1 ≥ legacy
 *   Per-category drop ≤ 3% (else focused fallback required before merge)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractContent } from '../../src/extraction/pipeline.js';
import {
  getExtractProvider,
  _resetExtractProviderForTest,
} from '../../src/providers/extract-provider.js';
import { computeMetrics } from './metrics.js';
import {
  loadManifest,
  loadFixtureHtml,
  loadGoldenMarkdown,
} from './runner.js';
import type { ManifestEntry } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'benchmarks', 'extraction', 'fixtures');
const GOLDEN_DIR = join(FIXTURES_DIR, 'golden');
const MANIFEST_PATH = join(FIXTURES_DIR, 'manifest.json');
const OUT_DIR = join(REPO_ROOT, 'benchmarks', 'extraction', 'output');

if (!process.env.RUN_EXTRACT_BENCH) {
  process.stderr.write(
    '[bench:per-category] Skipped. Set RUN_EXTRACT_BENCH=1 to run.\n',
  );
  process.exit(0);
}

interface PipelineResult {
  pipeline: 'legacy' | 'v1';
  extractor: string;
  markdown: string;
  latencyMs: number;
  f1: number;
  precision: number;
  recall: number;
  error?: string;
}

interface EntryComparison {
  id: string;
  url: string;
  category: string;
  legacy: PipelineResult;
  v1: PipelineResult;
  deltaF1: number;
}

interface CategoryAggregate {
  count: number;
  legacyF1: number;
  v1F1: number;
  deltaF1: number;
  withinGate: boolean;
}

interface PerCategoryReport {
  runDate: string;
  entryCount: number;
  legacyAggregateF1: number;
  v1AggregateF1: number;
  aggregateDeltaF1: number;
  aggregateGatePass: boolean;
  byCategory: Record<string, CategoryAggregate>;
  entries: EntryComparison[];
}

const PER_CATEGORY_DROP_THRESHOLD = 0.03;

async function extractOne(
  pipeline: 'legacy' | 'v1',
  entry: ManifestEntry,
  html: string,
  golden: string,
): Promise<PipelineResult> {
  const start = Date.now();
  try {
    const result =
      pipeline === 'legacy'
        ? await extractContent(html, entry.url)
        : await (await getExtractProvider()).extract(html, entry.url);
    const latencyMs = Date.now() - start;
    const metrics = computeMetrics(result.markdown, golden);
    return {
      pipeline,
      extractor: result.extractor,
      markdown: result.markdown,
      latencyMs,
      f1: metrics.f1,
      precision: metrics.precision,
      recall: metrics.recall,
    };
  } catch (err) {
    return {
      pipeline,
      extractor: 'unknown',
      markdown: '',
      latencyMs: Date.now() - start,
      f1: 0,
      precision: 0,
      recall: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

async function main(): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) {
    process.stderr.write(`[bench:per-category] Manifest missing at ${MANIFEST_PATH}\n`);
    process.exit(2);
  }

  const manifest = loadManifest(MANIFEST_PATH);
  const entries = manifest.entries;

  process.stderr.write(
    `[bench:per-category] Loaded ${entries.length} entries from manifest\n`,
  );

  _resetExtractProviderForTest();

  const comparisons: EntryComparison[] = [];

  for (const entry of entries) {
    try {
      const html = loadFixtureHtml(FIXTURES_DIR, entry.htmlFixturePath);
      const golden = loadGoldenMarkdown(GOLDEN_DIR, entry.goldenPath);

      const legacy = await extractOne('legacy', entry, html, golden);
      const v1 = await extractOne('v1', entry, html, golden);

      comparisons.push({
        id: entry.id,
        url: entry.url,
        category: entry.category,
        legacy,
        v1,
        deltaF1: v1.f1 - legacy.f1,
      });

      process.stderr.write(
        `[bench:per-category] ${entry.id.padEnd(20)} ` +
          `legacy=${legacy.f1.toFixed(3)} v1=${v1.f1.toFixed(3)} ` +
          `Δ=${(v1.f1 - legacy.f1).toFixed(3)}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[bench:per-category] entry ${entry.id} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const legacyAggregateF1 = average(comparisons.map((c) => c.legacy.f1));
  const v1AggregateF1 = average(comparisons.map((c) => c.v1.f1));

  const byCategory: Record<string, CategoryAggregate> = {};
  const categories = [...new Set(comparisons.map((c) => c.category))];
  for (const cat of categories) {
    const slice = comparisons.filter((c) => c.category === cat);
    const lF1 = average(slice.map((c) => c.legacy.f1));
    const vF1 = average(slice.map((c) => c.v1.f1));
    const delta = vF1 - lF1;
    byCategory[cat] = {
      count: slice.length,
      legacyF1: lF1,
      v1F1: vF1,
      deltaF1: delta,
      withinGate: delta >= -PER_CATEGORY_DROP_THRESHOLD,
    };
  }

  const report: PerCategoryReport = {
    runDate: new Date().toISOString(),
    entryCount: comparisons.length,
    legacyAggregateF1,
    v1AggregateF1,
    aggregateDeltaF1: v1AggregateF1 - legacyAggregateF1,
    aggregateGatePass: v1AggregateF1 >= legacyAggregateF1,
    byCategory,
    entries: comparisons,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, 'per-category.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

  process.stderr.write('\n[bench:per-category] === Quality Gate ===\n');
  process.stderr.write(
    `  legacy aggregate F1: ${legacyAggregateF1.toFixed(4)}\n` +
      `      v1 aggregate F1: ${v1AggregateF1.toFixed(4)}\n` +
      `      aggregate delta: ${(v1AggregateF1 - legacyAggregateF1).toFixed(4)} (gate ≥ 0: ${report.aggregateGatePass ? 'PASS' : 'FAIL'})\n\n`,
  );
  for (const [cat, agg] of Object.entries(byCategory)) {
    process.stderr.write(
      `  ${cat.padEnd(16)} n=${String(agg.count).padStart(2)} ` +
        `legacy=${agg.legacyF1.toFixed(3)} v1=${agg.v1F1.toFixed(3)} ` +
        `Δ=${agg.deltaF1.toFixed(3)} ` +
        `[${agg.withinGate ? 'PASS' : `FAIL (>${PER_CATEGORY_DROP_THRESHOLD} drop)`}]\n`,
    );
  }
  process.stderr.write(`\n[bench:per-category] Wrote ${outPath}\n`);

  const anyCategoryFail = Object.values(byCategory).some((a) => !a.withinGate);
  if (anyCategoryFail || !report.aggregateGatePass) {
    process.exit(3);
  }
}

main().catch((err) => {
  process.stderr.write(`[bench:per-category] Fatal: ${err}\n`);
  process.exit(1);
});
