import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/search/reranker/download.js', () => ({
  downloadModelAssets: vi.fn(async () => ({
    modelPath: '/tmp/fake/model.onnx',
    tokenizerPath: '/tmp/fake/tokenizer.json',
    configPath: '/tmp/fake/config.json',
  })),
}));

vi.mock('../../../../src/python/reranker-subprocess.js', () => {
  const score = vi.fn();
  const subproc = { score, isAvailable: () => true, shutdown: vi.fn() };
  return {
    getRerankSubprocess: vi.fn(() => subproc),
    resetAllRerankSubprocesses: vi.fn(),
    __subproc: subproc,
  };
});

vi.mock('../../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/wigolo', rerankerModel: 'bge-reranker-v2-m3' }),
}));

vi.mock('../../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  onnxRerank,
  disposeOnnxSessions,
  _resetOnnxSessionCache,
} from '../../../../src/search/reranker/onnx.js';
import * as sub from '../../../../src/python/reranker-subprocess.js';

describe('onnxRerank (Python-backed)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns docs sorted by score (desc)', async () => {
    (sub as any).__subproc.score.mockResolvedValue([0.2, 0.9, 0.5]);
    const out = await onnxRerank('q', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    expect(out).toHaveLength(3);
    expect(out[0].index).toBe(1);
    expect(out[0].score).toBe(0.9);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
  });

  it('passes doc.text array to subproc.score', async () => {
    (sub as any).__subproc.score.mockResolvedValue([0.1]);
    await onnxRerank('q', [{ text: 'hello' }]);
    expect((sub as any).__subproc.score).toHaveBeenCalledWith('q', ['hello']);
  });

  it('returns [] for empty docs without calling subprocess or download', async () => {
    const out = await onnxRerank('q', []);
    expect(out).toEqual([]);
    expect((sub as any).__subproc.score).not.toHaveBeenCalled();
    expect((sub as any).getRerankSubprocess).not.toHaveBeenCalled();
  });

  it('disposeOnnxSessions is a no-op that does not throw', async () => {
    await expect(disposeOnnxSessions()).resolves.toBeUndefined();
  });

  it('_resetOnnxSessionCache calls resetAllRerankSubprocesses', () => {
    _resetOnnxSessionCache();
    expect((sub as any).resetAllRerankSubprocesses).toHaveBeenCalled();
  });
});
