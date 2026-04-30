import { describe, expect, it, vi, beforeEach } from 'vitest';

const { startMock, stopMock, execSyncMock, existsSyncMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  stopMock: vi.fn(),
  execSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('../../../../src/searxng/process.js', () => ({
  SearxngProcess: vi.fn().mockImplementation(function (this: any) {
    this.start = startMock;
    this.stop = stopMock;
  }),
}));

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock('../../../../src/python-env.js', () => ({
  getPythonBin: (_dir: string) => '/fake/venv/python',
}));

vi.mock('../../../../src/config.js', () => ({
  getConfig: () => ({ rerankerModel: 'bge-reranker-v2-m3' }),
}));

vi.mock('../../../../src/search/reranker/models.js', () => ({
  resolveModelId: (id: string) => id,
}));

import { runVerify } from '../../../../src/cli/tui/verify.js';

class FakeReporter {
  events: string[] = [];
  start(id: string, label: string) { this.events.push(`start:${id}:${label}`); }
  update(id: string, text: string) { this.events.push(`update:${id}:${text}`); }
  progress(id: string, fraction: number) { this.events.push(`progress:${id}:${fraction}`); }
  success(id: string, detail?: string) { this.events.push(`success:${id}:${detail ?? ''}`); }
  fail(id: string, error: string) { this.events.push(`fail:${id}:${error}`); }
  note(text: string) { this.events.push(`note:${text}`); }
  finish() { this.events.push('finish'); }
}

beforeEach(() => {
  startMock.mockReset();
  stopMock.mockReset();
  execSyncMock.mockReset();
  existsSyncMock.mockReset();
  // default: reranker model files present
  existsSyncMock.mockReturnValue(true);
});

describe('runVerify — SearXNG branches', () => {
  it('returns searxng: failed and suggestion when start() throws', async () => {
    startMock.mockRejectedValueOnce(new Error('port bind'));

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.searxng).toBe('failed');
    expect(result.searxngError).toContain('port bind');
    expect(result.allPassed).toBe(false);
    expect(reporter.events).toContain('start:searxng:Starting search engine (searxng)');
    expect(reporter.events).toContain('fail:searxng:port bind');
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('returns searxng: failed when start() resolves to null', async () => {
    startMock.mockResolvedValueOnce(null);

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.searxng).toBe('failed');
    expect(reporter.events).toContain('fail:searxng:did not return a listening URL');
  });

  it('records searxng: ok and URL when start() resolves', async () => {
    startMock.mockResolvedValueOnce('http://127.0.0.1:8888');
    execSyncMock.mockReturnValue(Buffer.from(''));

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.searxng).toBe('ok');
    expect(result.searxngUrl).toBe('http://127.0.0.1:8888');
    expect(reporter.events).toContain('success:searxng:http://127.0.0.1:8888');
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});

describe('runVerify — package probes', () => {
  beforeEach(() => {
    startMock.mockResolvedValue('http://127.0.0.1:8888');
  });

  it('marks reranker ok when model files exist', async () => {
    existsSyncMock.mockReturnValue(true);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import trafilatura')) return Buffer.from('');
      if (cmd.includes('sentence_transformers')) return Buffer.from('384\n');
      throw new Error('unexpected cmd: ' + cmd);
    });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.reranker).toBe('ok');
    expect(result.trafilatura).toBe('ok');
    expect(result.embeddings).toBe('ok');
    expect(result.embeddingsDim).toBe(384);
    expect(reporter.events).toContain('success:reranker:installed (bge-reranker-v2-m3)');
    expect(reporter.events).toContain('success:trafilatura:installed');
    expect(reporter.events).toContain('success:embeddings:384-dim');
  });

  it('marks each package missing when its probe fails', async () => {
    existsSyncMock.mockReturnValue(false);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import trafilatura')) throw new Error('ModuleNotFoundError: trafilatura');
      if (cmd.includes('sentence_transformers')) throw new Error('ModuleNotFoundError: sentence_transformers');
      return Buffer.from('');
    });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.reranker).toBe('missing');
    expect(result.rerankerError).toContain('missing');
    expect(result.trafilatura).toBe('missing');
    expect(result.embeddings).toBe('missing');
    expect(result.embeddingsDim).toBeUndefined();
    expect(reporter.events).toContain('fail:reranker:not installed');
    expect(reporter.events).toContain('fail:trafilatura:not installed');
    expect(reporter.events).toContain('fail:embeddings:not installed');
  });

  it('marks embeddings missing when dim parse fails', async () => {
    existsSyncMock.mockReturnValue(true);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import trafilatura')) return Buffer.from('');
      if (cmd.includes('sentence_transformers')) return Buffer.from('not-a-number\n');
      throw new Error('unexpected cmd: ' + cmd);
    });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.embeddings).toBe('missing');
    expect(result.embeddingsError).toContain('could not parse');
  });

  it('allPassed is true only when every check is ok', async () => {
    existsSyncMock.mockReturnValue(true);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import trafilatura')) return Buffer.from('');
      if (cmd.includes('sentence_transformers')) return Buffer.from('384\n');
      throw new Error('unexpected cmd: ' + cmd);
    });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.allPassed).toBe(true);
  });
});

describe('runVerify — suggestions on failure', () => {
  it('emits one reporter.note per failing check when something failed', async () => {
    startMock.mockRejectedValueOnce(new Error('cannot bind'));

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.allPassed).toBe(false);
    const notes = reporter.events.filter(e => e.startsWith('note:'));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.some(n => n.includes('wigolo warmup --force'))).toBe(true);
  });

  it('emits no notes when everything passes', async () => {
    startMock.mockResolvedValue('http://127.0.0.1:8888');
    existsSyncMock.mockReturnValue(true);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import trafilatura')) return Buffer.from('');
      if (cmd.includes('sentence_transformers')) return Buffer.from('384\n');
      throw new Error('unexpected cmd: ' + cmd);
    });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.allPassed).toBe(true);
    const notes = reporter.events.filter(e => e.startsWith('note:'));
    expect(notes).toEqual([]);
  });
});
