import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { startMock, stopMock, execSyncMock, fetchMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  stopMock: vi.fn(),
  execSyncMock: vi.fn(),
  fetchMock: vi.fn(),
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

vi.mock('../../../../src/python-env.js', () => ({
  getPythonBin: (_dir: string) => '/fake/venv/python',
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
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runVerify — SearXNG branches', () => {
  it('returns searxng: failed and suggestion when start() throws', async () => {
    startMock.mockRejectedValueOnce(new Error('port bind'));

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.searxng).toBe('failed');
    expect(result.searxngError).toContain('port bind');
    expect(result.testSearch).toBe('skipped');
    expect(result.allPassed).toBe(false);
    expect(reporter.events).toContain('start:searxng:Starting SearXNG');
    expect(reporter.events).toContain('fail:searxng:port bind');
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('returns searxng: failed when start() resolves to null', async () => {
    startMock.mockResolvedValueOnce(null);

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.searxng).toBe('failed');
    expect(result.testSearch).toBe('skipped');
    expect(reporter.events).toContain('fail:searxng:did not return a listening URL');
  });

  it('records searxng: ok and URL when start() resolves', async () => {
    startMock.mockResolvedValueOnce('http://127.0.0.1:8888');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [{}, {}, {}] }),
    });
    execSyncMock.mockReturnValue(Buffer.from(''));

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.searxng).toBe('ok');
    expect(result.searxngUrl).toBe('http://127.0.0.1:8888');
    expect(reporter.events).toContain('success:searxng:http://127.0.0.1:8888');
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});

describe('runVerify — test search', () => {
  beforeEach(() => {
    startMock.mockResolvedValue('http://127.0.0.1:8888');
    execSyncMock.mockReturnValue(Buffer.from(''));
  });

  it('records testSearch: ok with count on 200', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [{}, {}, {}, {}, {}] }),
    });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.testSearch).toBe('ok');
    expect(result.testSearchCount).toBe(5);
    expect(reporter.events).toContain('start:test-search:Running test search');
    expect(reporter.events).toContain('success:test-search:5 results');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8888/search?q=test&format=json',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('records testSearch: ok with 0 count when results missing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.testSearch).toBe('ok');
    expect(result.testSearchCount).toBe(0);
    expect(reporter.events).toContain('success:test-search:0 results');
  });

  it('records testSearch: failed on non-2xx after retries', async () => {
    const badResponse = { ok: false, status: 502, json: async () => ({}) };
    fetchMock.mockResolvedValue(badResponse);

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.testSearch).toBe('failed');
    expect(result.testSearchError).toBe('HTTP 502');
    expect(reporter.events).toContain('fail:test-search:HTTP 502');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('records testSearch: failed when fetch throws after retries', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.testSearch).toBe('failed');
    expect(result.testSearchError).toContain('ECONNREFUSED');
    expect(reporter.events).toContain('fail:test-search:ECONNREFUSED');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('succeeds on retry after initial failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [{}, {}] }),
      });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.testSearch).toBe('ok');
    expect(result.testSearchCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('runVerify — python package probes', () => {
  beforeEach(() => {
    startMock.mockResolvedValue('http://127.0.0.1:8888');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
  });

  it('marks flashrank ok when import succeeds', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import flashrank')) return Buffer.from('');
      if (cmd.includes('import trafilatura')) return Buffer.from('');
      if (cmd.includes('sentence_transformers')) return Buffer.from('384\n');
      throw new Error('unexpected cmd: ' + cmd);
    });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.flashrank).toBe('ok');
    expect(result.trafilatura).toBe('ok');
    expect(result.embeddings).toBe('ok');
    expect(result.embeddingsDim).toBe(384);
    expect(reporter.events).toContain('success:flashrank:installed');
    expect(reporter.events).toContain('success:trafilatura:installed');
    expect(reporter.events).toContain('success:embeddings:384-dim');
  });

  it('marks each package missing when its import throws', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import flashrank')) throw new Error('ModuleNotFoundError: flashrank');
      if (cmd.includes('import trafilatura')) throw new Error('ModuleNotFoundError: trafilatura');
      if (cmd.includes('sentence_transformers')) throw new Error('ModuleNotFoundError: sentence_transformers');
      return Buffer.from('');
    });

    const reporter = new FakeReporter();
    const result = await runVerify('/tmp/wigolo-data', reporter);

    expect(result.flashrank).toBe('missing');
    expect(result.flashrankError).toContain('flashrank');
    expect(result.trafilatura).toBe('missing');
    expect(result.embeddings).toBe('missing');
    expect(result.embeddingsDim).toBeUndefined();
    expect(reporter.events).toContain('fail:flashrank:not installed');
    expect(reporter.events).toContain('fail:trafilatura:not installed');
    expect(reporter.events).toContain('fail:embeddings:not installed');
  });

  it('marks embeddings missing when dim parse fails', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import flashrank')) return Buffer.from('');
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
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import flashrank')) return Buffer.from('');
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
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{}] }),
    });
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('import flashrank')) return Buffer.from('');
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
