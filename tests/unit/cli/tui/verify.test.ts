import { describe, expect, it, vi, beforeEach } from 'vitest';

const { startMock, stopMock, rerankMock, existsSyncMock, readdirSyncMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  stopMock: vi.fn(),
  rerankMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
}));

vi.mock('../../../../src/searxng/process.js', () => ({
  SearxngProcess: vi.fn().mockImplementation(function (this: { start: typeof startMock; stop: typeof stopMock }) {
    this.start = startMock;
    this.stop = stopMock;
  }),
}));

// The embeddings probe is a filesystem check on the fastembed model dir, not a
// Python subprocess — mock node:fs so tests drive "installed / empty / absent".
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return { ...actual, existsSync: existsSyncMock, readdirSync: readdirSyncMock };
});

vi.mock('../../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: rerankMock,
  })),
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
  rerankMock.mockReset();
  existsSyncMock.mockReset();
  readdirSyncMock.mockReset();
  rerankMock.mockResolvedValue([{ id: '0', score: 0.5 }]);
  // Default: fastembed model dir present and non-empty (embeddings installed).
  existsSyncMock.mockReturnValue(true);
  readdirSyncMock.mockReturnValue(['model.onnx']);
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

  it('marks reranker and embeddings ok when the provider responds and the model dir is populated', async () => {
    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.reranker).toBe('ok');
    expect(result.embeddings).toBe('ok');
    expect(reporter.events).toContain('success:reranker:installed (Xenova/ms-marco-MiniLM-L-6-v2)');
    expect(reporter.events).toContain('success:embeddings:installed');
  });

  it('marks each package missing when its probe fails', async () => {
    rerankMock.mockRejectedValueOnce(new Error('model load failed'));
    existsSyncMock.mockReturnValue(false); // fastembed model dir absent

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.reranker).toBe('missing');
    expect(result.rerankerError).toContain('model load failed');
    expect(result.embeddings).toBe('missing');
    expect(result.embeddingsDim).toBeUndefined();
    expect(reporter.events).toContain('fail:reranker:not installed');
    expect(reporter.events).toContain('fail:embeddings:not installed');
  });

  it('marks embeddings missing when the model dir exists but is empty', async () => {
    // A present-but-empty fastembed dir means warmup never finished downloading
    // the model — treat it as not installed, not as ok.
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue([]);

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.embeddings).toBe('missing');
    expect(result.embeddingsError).toContain('empty or missing');
    expect(reporter.events).toContain('fail:embeddings:not installed');
  });

  it('allPassed is true only when every check is ok', async () => {
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

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.allPassed).toBe(true);
    const notes = reporter.events.filter(e => e.startsWith('note:'));
    expect(notes).toEqual([]);
  });
});
