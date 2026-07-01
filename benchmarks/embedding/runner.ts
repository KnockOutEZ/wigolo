#!/usr/bin/env node
/**
 * Embedding quality bench — nDCG@5, nDCG@10, MRR.
 *
 * Loads the fixed corpus + queries from benchmarks/search/fixtures/, embeds
 * all judged documents plus each query via fastembed, ranks by cosine
 * similarity, and computes retrieval quality metrics.
 *
 * Gated on RUN_FASTEMBED=1 (requires huggingface.co network for ONNX model).
 *
 * Run on dev host:
 *   RUN_FASTEMBED=1 tsx benchmarks/embedding/runner.ts
 *
 * Output: benchmarks/embedding/output/results.json
 *
 * Quality gates:
 *   nDCG@5  ≥ legacy baseline
 *   nDCG@10 ≥ legacy baseline
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastembedEmbedProvider } from '../../src/embedding/fastembed-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'benchmarks', 'search', 'fixtures');
const OUT_DIR = join(REPO_ROOT, 'benchmarks', 'embedding', 'output');
const BASELINE_PATH = join(OUT_DIR, 'baseline.json');

if (!process.env.RUN_FASTEMBED) {
  process.stderr.write(
    '[bench:embedding] Skipped. Set RUN_FASTEMBED=1 to run (requires huggingface.co network).\n',
  );
  process.exit(0);
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function dcg(relevances: number[]): number {
  return relevances.reduce(
    (acc, rel, i) => acc + (Math.pow(2, rel) - 1) / Math.log2(i + 2),
    0,
  );
}

function ndcgAtK(relevances: number[], idealRelevances: number[], k: number): number {
  const d = dcg(relevances.slice(0, k));
  const ideal = dcg([...idealRelevances].sort((a, b) => b - a).slice(0, k));
  return ideal === 0 ? 0 : d / ideal;
}

function mrr(relevances: number[]): number {
  const firstRel = relevances.findIndex(r => r > 0);
  return firstRel === -1 ? 0 : 1 / (firstRel + 1);
}

// ── Fixture types ─────────────────────────────────────────────────────────────

interface QueryFixture {
  id: string;
  query: string;
  category?: string;
}

interface RelevanceJudgment {
  queryId: string;
  url: string;
  grade: number;
}

interface QueriesFile {
  queries: QueryFixture[];
}

interface RelevanceFile {
  judgments: RelevanceJudgment[];
}

// ── Result types ──────────────────────────────────────────────────────────────

interface QueryResult {
  queryId: string;
  query: string;
  ndcg5: number;
  ndcg10: number;
  mrr: number;
  rankedUrls: string[];
}

interface AggregateMetrics {
  ndcg5: number;
  ndcg10: number;
  mrr: number;
}

interface BenchResults {
  timestamp: string;
  modelId: string;
  dim: number;
  queryCount: number;
  docCount: number;
  queries: QueryResult[];
  aggregate: AggregateMetrics;
  baselineComparison?: {
    baselineTimestamp: string;
    deltaNdcg5: number;
    deltaNdcg10: number;
    deltaMrr: number;
    gateNdcg5Pass: boolean;
    gateNdcg10Pass: boolean;
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const queriesPath = join(FIXTURES_DIR, 'queries.json');
  const relevancePath = join(FIXTURES_DIR, 'relevance.json');

  if (!existsSync(queriesPath) || !existsSync(relevancePath)) {
    process.stderr.write(
      `[bench:embedding] Fixtures missing.\n  Expected: ${queriesPath}\n           ${relevancePath}\n`,
    );
    process.exit(2);
  }

  const queriesFile = JSON.parse(readFileSync(queriesPath, 'utf-8')) as QueriesFile;
  const relevanceFile = JSON.parse(readFileSync(relevancePath, 'utf-8')) as RelevanceFile;

  const queries = queriesFile.queries;
  const judgments = relevanceFile.judgments;

  // Build a map: queryId -> { url -> grade }
  const relevanceMap = new Map<string, Map<string, number>>();
  for (const j of judgments) {
    if (!relevanceMap.has(j.queryId)) relevanceMap.set(j.queryId, new Map());
    relevanceMap.get(j.queryId)!.set(j.url, j.grade);
  }

  // Collect all unique judged URLs as the corpus
  const allUrls = [...new Set(judgments.map(j => j.url))];
  // Use URLs as document text (realistic proxy for what would be doc snippets)
  const docTexts = allUrls;

  process.stderr.write(
    `[bench:embedding] Loaded ${queries.length} queries, ${judgments.length} judgments, ${allUrls.length} unique docs\n`,
  );

  const provider = new FastembedEmbedProvider();
  process.stderr.write('[bench:embedding] Warming up model...\n');
  await provider.warmup();
  process.stderr.write(`[bench:embedding] Model ready: ${provider.modelId} (dim=${provider.dim})\n`);

  // Embed all documents in one batch
  process.stderr.write('[bench:embedding] Embedding corpus...\n');
  const docEmbeddings = await provider.embed(docTexts);

  // Embed all queries in one batch
  const queryTexts = queries.map(q => q.query);
  process.stderr.write('[bench:embedding] Embedding queries...\n');
  const queryEmbeddings = await provider.embed(queryTexts);

  const queryResults: QueryResult[] = [];

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    const qVec = queryEmbeddings[qi];
    const qRelevance = relevanceMap.get(q.id);

    if (!qRelevance || qRelevance.size === 0) {
      // No judgments for this query — skip
      continue;
    }

    // Score each doc by cosine similarity
    const scored = allUrls.map((url, di) => ({
      url,
      score: cosine(qVec, docEmbeddings[di]),
    }));
    scored.sort((a, b) => b.score - a.score);

    // Extract ordered relevance grades (0 for unjudged docs)
    const rankedRelevances = scored.map(s => qRelevance.get(s.url) ?? 0);
    const idealRelevances = [...qRelevance.values()];

    const qNdcg5 = ndcgAtK(rankedRelevances, idealRelevances, 5);
    const qNdcg10 = ndcgAtK(rankedRelevances, idealRelevances, 10);
    const qMrr = mrr(rankedRelevances);

    queryResults.push({
      queryId: q.id,
      query: q.query,
      ndcg5: qNdcg5,
      ndcg10: qNdcg10,
      mrr: qMrr,
      rankedUrls: scored.slice(0, 10).map(s => s.url),
    });
  }

  const n = queryResults.length;
  const aggregate: AggregateMetrics =
    n === 0
      ? { ndcg5: 0, ndcg10: 0, mrr: 0 }
      : {
          ndcg5: queryResults.reduce((s, r) => s + r.ndcg5, 0) / n,
          ndcg10: queryResults.reduce((s, r) => s + r.ndcg10, 0) / n,
          mrr: queryResults.reduce((s, r) => s + r.mrr, 0) / n,
        };

  process.stderr.write(
    `[bench:embedding] Aggregate nDCG@5=${aggregate.ndcg5.toFixed(4)}  nDCG@10=${aggregate.ndcg10.toFixed(4)}  MRR=${aggregate.mrr.toFixed(4)}\n`,
  );

  const results: BenchResults = {
    timestamp: new Date().toISOString(),
    modelId: provider.modelId,
    dim: provider.dim,
    queryCount: n,
    docCount: allUrls.length,
    queries: queryResults,
    aggregate,
  };

  // Compare to baseline if it exists
  if (existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as {
      timestamp: string;
      aggregate: AggregateMetrics;
    };
    results.baselineComparison = {
      baselineTimestamp: baseline.timestamp,
      deltaNdcg5: aggregate.ndcg5 - baseline.aggregate.ndcg5,
      deltaNdcg10: aggregate.ndcg10 - baseline.aggregate.ndcg10,
      deltaMrr: aggregate.mrr - baseline.aggregate.mrr,
      gateNdcg5Pass: aggregate.ndcg5 >= baseline.aggregate.ndcg5,
      gateNdcg10Pass: aggregate.ndcg10 >= baseline.aggregate.ndcg10,
    };
    process.stderr.write(
      `[bench:embedding] vs baseline: ΔnDCG@5=${results.baselineComparison.deltaNdcg5.toFixed(4)} gate=${results.baselineComparison.gateNdcg5Pass ? 'PASS' : 'FAIL'}\n`,
    );
  } else {
    process.stderr.write(
      `[bench:embedding] No baseline found at ${BASELINE_PATH} — skipping comparison.\n` +
        `  To save this run as baseline: cp ${OUT_DIR}/results.json ${BASELINE_PATH}\n`,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, 'results.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  process.stderr.write(`[bench:embedding] Wrote ${outPath}\n`);
}

main().catch(err => {
  process.stderr.write(`[bench:embedding] Fatal: ${err}\n`);
  process.exit(1);
});
