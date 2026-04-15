import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const startMock = vi.fn();
const stopMock = vi.fn();
const execSyncMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../../../src/searxng/process.js', () => ({
  SearxngProcess: vi.fn().mockImplementation(() => ({
    start: startMock,
    stop: stopMock,
  })),
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
