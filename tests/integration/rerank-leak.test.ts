import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { onnxRerank } from '../../src/search/reranker/onnx.js';
import {
  getRerankSubprocess,
  resetAllRerankSubprocesses,
} from '../../src/python/reranker-subprocess.js';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const skip = !process.env.WIGOLO_RERANKER_TEST;

function pythonRss(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? parseInt(m[1], 10) * 1024 : 0;
  } catch {
    const out = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return parseInt(out, 10) * 1024;
  }
}

describe.skipIf(skip)('integration: rerank stability over many calls', () => {
  beforeEach(() => resetAllRerankSubprocesses());
  afterEach(() => resetAllRerankSubprocesses());

  it('1000 rerank calls: subprocess RSS grows by < 100 MB; no FD explosion', async () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({ text: `doc ${i} about something` }));
    await onnxRerank('warm', docs);
    const sub = getRerankSubprocess('bge-reranker-v2-m3', 512);
    const proc = sub.worker._getProcessForTest();
    expect(proc).not.toBeNull();
    const pid = proc!.pid as number;
    const baselineRss = pythonRss(pid);
    const fdBaseline = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? 0;

    for (let i = 0; i < 1000; i++) {
      await onnxRerank(`q ${i}`, docs);
    }

    const finalRss = pythonRss(pid);
    const fdFinal = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? 0;

    expect(finalRss - baselineRss).toBeLessThan(100 * 1024 * 1024);
    expect(fdFinal - fdBaseline).toBeLessThan(10);
  }, 120_000);
});
