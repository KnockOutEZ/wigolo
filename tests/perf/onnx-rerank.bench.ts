import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { onnxRerank, _resetOnnxSessionCache } from '../../src/search/reranker/onnx.js';
import { resolveModelId } from '../../src/search/reranker/models.js';

const modelId = resolveModelId(process.env.WIGOLO_RERANKER_MODEL ?? 'ms-marco-MiniLM-L-12-v2');
const maxLength = Number(process.env.WIGOLO_RERANKER_MAX_LENGTH ?? '128');
const modelPath = join(
  process.env.WIGOLO_DATA_DIR ?? join(homedir(), '.wigolo'),
  'models',
  modelId,
  'model_quantized.onnx',
);
const skip = !existsSync(modelPath) && !process.env.WIGOLO_PERF_TEST;

describe.skipIf(skip)('rerank perf', () => {
  it('top-30 rerank p95 < 600ms and within 1.05x baseline', async () => {
    _resetOnnxSessionCache();
    const docs = Array.from({ length: 30 }, (_, i) => ({
      text: `doc ${i} about pgEdge multi-master replication and conflict resolution`,
    }));
    await onnxRerank('pgEdge multi-master', docs, { modelId, maxLength });
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await onnxRerank('pgEdge multi-master', docs, { modelId, maxLength });
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    process.stderr.write(`rerank p95: ${p95} ms (samples: ${samples.join(', ')})\n`);

    const baselinePath = process.env.WIGOLO_RERANKER_BASELINE;
    if (baselinePath && existsSync(baselinePath)) {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as { p95: number };
      const ratio = p95 / baseline.p95;
      process.stderr.write(`rerank A/B ratio: ${ratio.toFixed(3)} (baseline p95=${baseline.p95}ms)\n`);
      expect(ratio, `regression ${(ratio * 100).toFixed(1)}% vs baseline p95=${baseline.p95}ms`).toBeLessThanOrEqual(1.05);
    }

    expect(p95).toBeLessThan(600);

    if (process.env.WIGOLO_RERANKER_WRITE_BASELINE) {
      writeFileSync(process.env.WIGOLO_RERANKER_WRITE_BASELINE,
        JSON.stringify({ p95, samples, modelId, maxLength, ts: new Date().toISOString() }, null, 2));
    }
  }, 120000);
});
