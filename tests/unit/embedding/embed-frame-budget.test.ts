// Frame-budget guard (Studio Phase 0, Task 1 / 0b.3).
//
// In-process ONNX embedding must not block the Node event loop hard enough to
// drop a 30fps Studio screencast frame (33ms/frame budget). The Task-1 spike
// measured ~1.4ms worst-case event-loop stall under a 120-chunk burst (fastembed
// runs ONNX off the JS thread). This test guards against a regression — e.g. a
// dependency change that starts running inference synchronously on the JS thread
// — which would blow past the budget. Verdict A (in-process, no child isolation).
//
// Gated on RUN_FASTEMBED=1 because it needs the real model (network download on
// first run); CI/sandbox stay green without the flag.
import { describe, it, expect, beforeAll } from 'vitest';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { FastembedEmbedProvider } from '../../../src/embedding/fastembed-provider.js';

const FRAME_BUDGET_MS = 33; // 30fps
const NS_PER_MS = 1e6;

function buildChunks(n: number, wordsPerChunk: number): string[] {
  const lexicon = (
    'session browser studio embedding vector index cache fetch crawl extract research ' +
    'agent daemon proxy token origin host timeout concurrency sqlite reranker semantic ' +
    'search latency frame budget event loop delay capture artifact knowledge playwright'
  ).split(' ');
  const chunks: string[] = [];
  for (let i = 0; i < n; i++) {
    const words: string[] = [];
    for (let w = 0; w < wordsPerChunk; w++) {
      words.push(lexicon[(i * 7 + w * 13) % lexicon.length]);
    }
    chunks.push(`chunk-${i}: ${words.join(' ')}.`);
  }
  return chunks;
}

describe.skipIf(!process.env.RUN_FASTEMBED)('embedding frame-budget guard (RUN_FASTEMBED=1)', () => {
  let provider: FastembedEmbedProvider;

  beforeAll(async () => {
    provider = new FastembedEmbedProvider();
    await provider.warmup(); // pay the one-time model load OUTSIDE the measured window
  }, 120_000);

  it('keeps event-loop stall under the 30fps frame budget while embedding a 120-chunk burst', async () => {
    const chunks = buildChunks(120, 450);
    // Warm steady-state once more outside the window so we measure embedding, not lazy init.
    await provider.embed(['warmup probe for the frame-budget guard']);

    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    const vectors = await provider.embed(chunks);
    h.disable();

    const maxStallMs = h.max / NS_PER_MS;
    expect(vectors).toHaveLength(chunks.length);
    // Measured ~1.4ms. A regression that runs ONNX synchronously on the JS thread
    // would stall for tens-to-hundreds of ms and trip this.
    expect(maxStallMs).toBeLessThan(FRAME_BUDGET_MS);
  }, 120_000);
});
