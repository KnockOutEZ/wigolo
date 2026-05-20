import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { onnxRerank } from '../../src/search/reranker/onnx.js';
import {
  getRerankSubprocess,
  resetAllRerankSubprocesses,
} from '../../src/python/reranker-subprocess.js';

const skip = !process.env.WIGOLO_RERANKER_TEST;

describe.skipIf(skip)('integration: rerank respawns after crash', () => {
  beforeEach(() => resetAllRerankSubprocesses());
  afterEach(() => resetAllRerankSubprocesses());

  it('kill subprocess externally; next call respawns and succeeds', async () => {
    await onnxRerank('warmup', [{ text: 'd' }]);
    const sub = getRerankSubprocess('bge-reranker-v2-m3', 512);
    const proc = sub.worker._getProcessForTest();
    expect(proc).not.toBeNull();
    expect(proc!.pid).toBeDefined();
    proc!.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    const out = await onnxRerank('after kill', [{ text: 'still works' }]);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBeGreaterThanOrEqual(0);
    expect(out[0].score).toBeLessThanOrEqual(1);
  }, 30_000);
});
