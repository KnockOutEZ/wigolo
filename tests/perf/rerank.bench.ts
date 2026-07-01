/**
 * Rerank throughput perf bench (gated on RUN_TRANSFORMERS=1).
 *
 * Performance gates (captured on dev host):
 *   batch 5  P50 ≤ 150ms
 *   batch 20 P50 ≤ 400ms
 *   batch 50 P50 ≤ 800ms
 *
 * Requires huggingface.co network access on first run to download the
 * cross-encoder model (~22 MB). Subsequent runs reuse ~/.wigolo/transformers
 * cache.
 *
 * Run on dev host:
 *   RUN_TRANSFORMERS=1 npm run test:perf -- tests/perf/rerank.bench.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { TransformersRerankProvider } from '../../src/search/reranker/transformers-rerank-provider.js';
import type { RerankCandidate } from '../../src/providers/rerank-provider.js';

const GATED = !process.env.RUN_TRANSFORMERS;

const QUERY = 'react server components hydration';

const DOCS: string[] = [
  'React Server Components render on the server and stream to the client.',
  'Next.js App Router defaults to RSC for all routes unless opted out.',
  'Bananas are an excellent source of potassium and dietary fibre.',
  'TypeScript adds static types and structural inference to JavaScript.',
  'The Eiffel Tower is a wrought-iron lattice tower in Paris, France.',
  'Hydration is the process of attaching event handlers to server-rendered HTML.',
  'React useEffect runs after the DOM is committed, not during render.',
  'Suspense boundaries let you stream and reveal content incrementally.',
  'CSS-in-JS libraries serialize styles to <style> tags at render time.',
  'GraphQL uses a schema to describe queryable types and their fields.',
];

function p50(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)];
}

async function time(fn: () => Promise<unknown>): Promise<number> {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
}

function makeCandidates(count: number): RerankCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    text: DOCS[i % DOCS.length],
  }));
}

describe.skipIf(GATED)('rerank throughput (gated on RUN_TRANSFORMERS=1)', () => {
  let provider: TransformersRerankProvider;

  beforeAll(async () => {
    provider = new TransformersRerankProvider();
    await provider.warmup();
  }, 120_000);

  it('warmup-only rerank (single batch sanity)', async () => {
    const ms = await time(() => provider.rerank(QUERY, makeCandidates(5)));
    process.stderr.write(`[perf] rerank warmup: ${ms}ms\n`);
    expect(ms).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('batch 5 P50 ≤ 150ms', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push(await time(() => provider.rerank(QUERY, makeCandidates(5))));
    }
    const result = p50(samples);
    process.stderr.write(`[perf] rerank batch-5 p50=${result}ms samples=[${samples.join(',')}]\n`);
    expect(result, `batch-5 P50 ${result}ms exceeded 150ms gate`).toBeLessThanOrEqual(150);
  }, 60_000);

  it('batch 20 P50 ≤ 400ms', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(await time(() => provider.rerank(QUERY, makeCandidates(20))));
    }
    const result = p50(samples);
    process.stderr.write(`[perf] rerank batch-20 p50=${result}ms samples=[${samples.join(',')}]\n`);
    expect(result, `batch-20 P50 ${result}ms exceeded 400ms gate`).toBeLessThanOrEqual(400);
  }, 60_000);

  it('batch 50 P50 ≤ 800ms', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      samples.push(await time(() => provider.rerank(QUERY, makeCandidates(50))));
    }
    const result = p50(samples);
    process.stderr.write(`[perf] rerank batch-50 p50=${result}ms samples=[${samples.join(',')}]\n`);
    expect(result, `batch-50 P50 ${result}ms exceeded 800ms gate`).toBeLessThanOrEqual(800);
  }, 90_000);
});
