#!/usr/bin/env node
/**
 * Rerank quality bench — nDCG@5, nDCG@10, MRR.
 *
 * Loads the fixed corpus + queries from benchmarks/search/fixtures/, scores
 * each judged document against each query via the cross-encoder reranker,
 * and computes retrieval quality metrics.
 *
 * Gated on RUN_TRANSFORMERS=1 (requires huggingface.co network for the ONNX
 * cross-encoder model on first run).
 *
 * Run on dev host:
 *   RUN_TRANSFORMERS=1 tsx benchmarks/search/rerank-quality.ts
 *
 * Output: benchmarks/search/output/rerank-quality.json
 *
 * Quality gates:
 *   nDCG@5  ≥ legacy reranker baseline
 *   nDCG@10 ≥ legacy reranker baseline
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TransformersRerankProvider } from '../../src/search/reranker/transformers-rerank-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'benchmarks', 'search', 'fixtures');
const OUT_DIR = join(REPO_ROOT, 'benchmarks', 'search', 'output');
const BASELINE_PATH = join(OUT_DIR, 'rerank-quality-baseline.json');

if (!process.env.RUN_TRANSFORMERS) {
  process.stderr.write(
    '[bench:rerank-quality] Skipped. Set RUN_TRANSFORMERS=1 to run (requires huggingface.co network).\n',
  );
  process.exit(0);
}

// ── Math helpers ─────────────────────────────────────────────────────────────

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
      `[bench:rerank-quality] Fixtures missing.\n  Expected: ${queriesPath}\n           ${relevancePath}\n`,
    );
    process.exit(2);
  }

  const queriesFile = JSON.parse(readFileSync(queriesPath, 'utf-8')) as QueriesFile;
  const relevanceFile = JSON.parse(readFileSync(relevancePath, 'utf-8')) as RelevanceFile;

  const queries = queriesFile.queries;
  const judgments = relevanceFile.judgments;

  const relevanceMap = new Map<string, Map<string, number>>();
  for (const j of judgments) {
    if (!relevanceMap.has(j.queryId)) relevanceMap.set(j.queryId, new Map());
    relevanceMap.get(j.queryId)!.set(j.url, j.grade);
  }

  const allUrls = [...new Set(judgments.map(j => j.url))];

  process.stderr.write(
    `[bench:rerank-quality] Loaded ${queries.length} queries, ${judgments.length} judgments, ${allUrls.length} unique docs\n`,
  );

  const provider = new TransformersRerankProvider();
  process.stderr.write('[bench:rerank-quality] Warming up model...\n');
  await provider.warmup();
  process.stderr.write(`[bench:rerank-quality] Model ready: ${provider.modelId}\n`);

  const queryResults: QueryResult[] = [];

  for (const q of queries) {
    const qRelevance = relevanceMap.get(q.id);
    if (!qRelevance || qRelevance.size === 0) continue;

    const candidates = allUrls.map((url, idx) => ({ id: String(idx), text: url }));
    const ranked = await provider.rerank(q.query, candidates, candidates.length);

    const rankedRelevances = ranked.map(r => qRelevance.get(allUrls[Number(r.id)]) ?? 0);
    const idealRelevances = [...qRelevance.values()];

    queryResults.push({
      queryId: q.id,
      query: q.query,
      ndcg5: ndcgAtK(rankedRelevances, idealRelevances, 5),
      ndcg10: ndcgAtK(rankedRelevances, idealRelevances, 10),
      mrr: mrr(rankedRelevances),
      rankedUrls: ranked.slice(0, 10).map(r => allUrls[Number(r.id)]),
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
    `[bench:rerank-quality] Aggregate nDCG@5=${aggregate.ndcg5.toFixed(4)}  nDCG@10=${aggregate.ndcg10.toFixed(4)}  MRR=${aggregate.mrr.toFixed(4)}\n`,
  );

  const results: BenchResults = {
    timestamp: new Date().toISOString(),
    modelId: provider.modelId,
    queryCount: n,
    docCount: allUrls.length,
    queries: queryResults,
    aggregate,
  };

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
      `[bench:rerank-quality] vs baseline (${baseline.timestamp}): ΔnDCG@5=${results.baselineComparison.deltaNdcg5.toFixed(4)}  ΔnDCG@10=${results.baselineComparison.deltaNdcg10.toFixed(4)}\n`,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'rerank-quality.json'),
    JSON.stringify(results, null, 2) + '\n',
    'utf-8',
  );
  process.stderr.write(`[bench:rerank-quality] Wrote ${join(OUT_DIR, 'rerank-quality.json')}\n`);
}

main().catch(err => {
  process.stderr.write(`[bench:rerank-quality] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
