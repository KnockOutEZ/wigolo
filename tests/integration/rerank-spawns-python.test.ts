import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onnxRerank } from '../../src/search/reranker/onnx.js';
import { resetAllRerankSubprocesses } from '../../src/python/reranker-subprocess.js';

const skip = !process.env.WIGOLO_RERANKER_TEST;

describe.skipIf(skip)('integration: rerank spawns python subprocess', () => {
  beforeEach(() => resetAllRerankSubprocesses());
  afterEach(() => resetAllRerankSubprocesses());

  it('first onnxRerank spawns one python subprocess; second reuses', async () => {
    const spawnSpy = vi.spyOn(await import('node:child_process'), 'spawn');
    await onnxRerank('test query', [
      { text: 'doc 1' },
      { text: 'doc 2' },
    ]);
    const pyCallsAfter1 = spawnSpy.mock.calls.filter(([cmd]) =>
      typeof cmd === 'string' && /python/.test(cmd as string),
    ).length;
    expect(pyCallsAfter1).toBe(1);
    await onnxRerank('test query 2', [{ text: 'doc 3' }]);
    const pyCallsAfter2 = spawnSpy.mock.calls.filter(([cmd]) =>
      typeof cmd === 'string' && /python/.test(cmd as string),
    ).length;
    expect(pyCallsAfter2).toBe(1);
  });
});
