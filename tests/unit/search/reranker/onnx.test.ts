import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('onnxruntime-node', () => {
  const sessionRun = vi.fn(async () => ({
    logits: { data: new Float32Array([0.0]) },
  }));
  const session = { run: sessionRun, inputNames: ['input_ids', 'attention_mask', 'token_type_ids'], outputNames: ['logits'] };
  class Tensor {
    type: string;
    data: unknown;
    dims: number[];
    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  return {
    InferenceSession: { create: vi.fn(async () => session) },
    Tensor,
    __sessionRun: sessionRun,
  };
});

vi.mock('../../../../src/search/reranker/download.js', () => ({
  downloadModelAssets: vi.fn(async () => ({
    modelPath: '/tmp/fake/model.onnx',
    tokenizerPath: '/tmp/fake/tokenizer.json',
    configPath: '/tmp/fake/config.json',
  })),
}));

vi.mock('../../../../src/search/reranker/tokenizer.js', () => ({
  loadTokenizer: vi.fn(async () => ({ encode: () => ({}) })),
  tokenizePair: vi.fn(() => ({
    input_ids: new BigInt64Array(8),
    attention_mask: new BigInt64Array(8),
    token_type_ids: new BigInt64Array(8),
    length: 8,
  })),
}));

vi.mock('../../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/wigolo', rerankerModel: 'bge-reranker-v2-m3' }),
}));

vi.mock('../../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { onnxRerank, _resetOnnxSessionCache } from '../../../../src/search/reranker/onnx.js';
import * as ort from 'onnxruntime-node';

describe('onnxRerank', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOnnxSessionCache();
  });

  it('returns docs ordered by score, monotonically non-increasing', async () => {
    const logits = [-1.0, 2.5, 0.5];
    let i = 0;
    (ort as any).__sessionRun.mockImplementation(async () => ({
      logits: { data: new Float32Array([logits[i++]]) },
    }));

    const result = await onnxRerank('q', [
      { text: 'doc A' }, { text: 'doc B' }, { text: 'doc C' },
    ]);

    expect(result).toHaveLength(3);
    expect(result[0].index).toBe(1);
    for (let j = 1; j < result.length; j++) {
      expect(result[j - 1].score).toBeGreaterThanOrEqual(result[j].score);
    }
  });

  it('applies sigmoid to raw logits (scores in [0,1])', async () => {
    let i = 0;
    const logits = [0.0, 10.0];
    (ort as any).__sessionRun.mockImplementation(async () => ({
      logits: { data: new Float32Array([logits[i++]]) },
    }));
    const out = await onnxRerank('q', [{ text: 'a' }, { text: 'b' }]);
    expect(out.find((r) => r.index === 0)!.score).toBeCloseTo(0.5, 5);
    expect(out.find((r) => r.index === 1)!.score).toBeGreaterThan(0.99);
    expect(out.every((r) => r.score >= 0 && r.score <= 1)).toBe(true);
  });

  it('returns empty for empty input without spawning session', async () => {
    const out = await onnxRerank('q', []);
    expect(out).toEqual([]);
    expect(ort.InferenceSession.create).not.toHaveBeenCalled();
  });

  it('caches session across calls (single create)', async () => {
    (ort as any).__sessionRun.mockResolvedValue({ logits: { data: new Float32Array([1.0]) } });
    await onnxRerank('q', [{ text: 'a' }]);
    await onnxRerank('q2', [{ text: 'b' }]);
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
  });
});
