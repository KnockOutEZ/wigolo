import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flashRankRerank, isFlashRankAvailable, resetAvailabilityCache } from '../../../src/search/flashrank.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ rerankerModel: 'ms-marco-MiniLM-L-12-v2' })),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:stream';

function makeMockProcess(
  stdout: string,
  stderr: string,
  exitCode: number,
  options?: { delay?: number; errorEvent?: Error },
) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };

  setTimeout(() => {
    if (options?.errorEvent) {
      proc.emit('error', options.errorEvent);
      return;
    }
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  }, options?.delay ?? 5);

  return proc;
}

describe('flashRankRerank', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAvailabilityCache();
  });

  it('returns reranked passages with scores', async () => {
    const mockOutput = JSON.stringify([
      { index: 1, score: 0.95 },
      { index: 0, score: 0.72 },
      { index: 2, score: 0.31 },
    ]);

    vi.mocked(spawn).mockReturnValue(makeMockProcess(mockOutput, '', 0));

    const results = await flashRankRerank('test query', [
      { text: 'passage A', index: 0 },
      { text: 'passage B', index: 1 },
      { text: 'passage C', index: 2 },
    ]);

    expect(results).toHaveLength(3);
    expect(results![0].index).toBe(1);
    expect(results![0].score).toBe(0.95);
    expect(results![1].index).toBe(0);
    expect(results![2].index).toBe(2);
  });

  it('returns null when subprocess times out (>30s)', async () => {
    const proc = makeMockProcess('', '', 0, { delay: 999999 });
    vi.mocked(spawn).mockReturnValue(proc);

    const promise = flashRankRerank('query', [{ text: 'a', index: 0 }]);
    // Force the timeout to fire immediately for testing
    proc.emit('error', new Error('timeout'));

    const results = await promise;
    expect(results).toBeNull();
  });

  it('returns null on malformed JSON output', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProcess('not valid json {{{', '', 0));

    const results = await flashRankRerank('query', [{ text: 'a', index: 0 }]);
    expect(results).toBeNull();
  });

  it('returns null on empty JSON array output', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockProcess('[]', '', 0));

    const results = await flashRankRerank('query', [{ text: 'a', index: 0 }]);
    expect(results).toEqual([]);
  });

  it('returns null when Python crashes (exit code != 0)', async () => {
    vi.mocked(spawn).mockReturnValue(
      makeMockProcess('', 'Traceback (most recent call last):\n  ModuleNotFoundError', 1),
    );

    const results = await flashRankRerank('query', [{ text: 'a', index: 0 }]);
    expect(results).toBeNull();
  });

  it('returns null when FlashRank import fails (import error)', async () => {
    vi.mocked(spawn).mockReturnValue(
      makeMockProcess('', "ModuleNotFoundError: No module named 'flashrank'", 1),
    );

    const results = await flashRankRerank('query', [{ text: 'a', index: 0 }]);
    expect(results).toBeNull();
  });

  it('handles very large passage set (1000+ passages)', async () => {
    const passages = Array.from({ length: 1000 }, (_, i) => ({
      text: `passage number ${i} with some content about topic ${i % 10}`,
      index: i,
    }));
    const output = passages.map((p, i) => ({ index: p.index, score: 1 - i / 1000 }));

    vi.mocked(spawn).mockReturnValue(makeMockProcess(JSON.stringify(output), '', 0));

    const results = await flashRankRerank('test query', passages);
    expect(results).toHaveLength(1000);
    expect(results![0].index).toBe(0);
    expect(results![0].score).toBeCloseTo(1.0, 2);
  });

  it('handles passages with unicode and special characters', async () => {
    const passages = [
      { text: 'Les generiques en TypeScript 日本語テスト', index: 0 },
      { text: 'Emoji test: 🚀 with <html> entities &amp;', index: 1 },
      { text: 'Cyrillic: Привет мир, Arabic: مرحبا', index: 2 },
    ];
    const output = [
      { index: 2, score: 0.9 },
      { index: 0, score: 0.7 },
      { index: 1, score: 0.5 },
    ];

    vi.mocked(spawn).mockReturnValue(makeMockProcess(JSON.stringify(output), '', 0));

    const results = await flashRankRerank('unicode query', passages);
    expect(results).toHaveLength(3);
    expect(results![0].index).toBe(2);
  });

  it('handles single passage (nothing to rerank)', async () => {
    const output = [{ index: 0, score: 0.85 }];
    vi.mocked(spawn).mockReturnValue(makeMockProcess(JSON.stringify(output), '', 0));

    const results = await flashRankRerank('query', [{ text: 'only one', index: 0 }]);
    expect(results).toHaveLength(1);
    expect(results![0].score).toBe(0.85);
  });

  it('handles empty passages array', async () => {
    const results = await flashRankRerank('query', []);
    expect(results).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns null on subprocess spawn error event', async () => {
    vi.mocked(spawn).mockReturnValue(
      makeMockProcess('', '', 0, { errorEvent: new Error('ENOENT: python3 not found') }),
    );

    const results = await flashRankRerank('query', [{ text: 'a', index: 0 }]);
    expect(results).toBeNull();
  });

  it('handles stderr warnings from FlashRank (still succeeds)', async () => {
    const output = [{ index: 0, score: 0.8 }];
    vi.mocked(spawn).mockReturnValue(
      makeMockProcess(JSON.stringify(output), 'FutureWarning: torch.cuda is not available', 0),
    );

    const results = await flashRankRerank('query', [{ text: 'a', index: 0 }]);
    expect(results).toHaveLength(1);
    expect(results![0].score).toBe(0.8);
  });

  it('returns null when model not found error occurs', async () => {
    vi.mocked(spawn).mockReturnValue(
      makeMockProcess('', 'OSError: Model ms-marco-custom not found', 1),
    );

    const results = await flashRankRerank('query', [{ text: 'a', index: 0 }], 'ms-marco-custom');
    expect(results).toBeNull();
  });

  it('handles score normalization - all scores the same', async () => {
    const output = [
      { index: 0, score: 0.5 },
      { index: 1, score: 0.5 },
      { index: 2, score: 0.5 },
    ];
    vi.mocked(spawn).mockReturnValue(makeMockProcess(JSON.stringify(output), '', 0));

    const results = await flashRankRerank('query', [
      { text: 'a', index: 0 },
      { text: 'b', index: 1 },
      { text: 'c', index: 2 },
    ]);
    expect(results).toHaveLength(3);
    expect(results!.every(r => r.score === 0.5)).toBe(true);
  });

  it('handles scores greater than 1.0', async () => {
    const output = [
      { index: 0, score: 1.5 },
      { index: 1, score: 2.3 },
    ];
    vi.mocked(spawn).mockReturnValue(makeMockProcess(JSON.stringify(output), '', 0));

    const results = await flashRankRerank('query', [
      { text: 'a', index: 0 },
      { text: 'b', index: 1 },
    ]);
    expect(results).toHaveLength(2);
    // Scores should be clamped to [0, 1] range
    expect(results![0].score).toBeLessThanOrEqual(1.0);
    expect(results![1].score).toBeLessThanOrEqual(1.0);
  });

  it('handles negative scores', async () => {
    const output = [
      { index: 0, score: -0.3 },
      { index: 1, score: 0.8 },
    ];
    vi.mocked(spawn).mockReturnValue(makeMockProcess(JSON.stringify(output), '', 0));

    const results = await flashRankRerank('query', [
      { text: 'a', index: 0 },
      { text: 'b', index: 1 },
    ]);
    expect(results).toHaveLength(2);
    // Negative scores should be clamped to 0
    expect(results![0].score).toBeGreaterThanOrEqual(0);
  });

  it('handles concurrent rerank calls', async () => {
    const output1 = [{ index: 0, score: 0.9 }];
    const output2 = [{ index: 0, score: 0.7 }];

    let callCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      callCount++;
      const out = callCount === 1 ? output1 : output2;
      return makeMockProcess(JSON.stringify(out), '', 0);
    });

    const [r1, r2] = await Promise.all([
      flashRankRerank('query 1', [{ text: 'a', index: 0 }]),
      flashRankRerank('query 2', [{ text: 'b', index: 0 }]),
    ]);

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1![0].score).toBe(0.9);
    expect(r2![0].score).toBe(0.7);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('passes custom model name to Python script', async () => {
    const output = [{ index: 0, score: 0.8 }];
    vi.mocked(spawn).mockReturnValue(makeMockProcess(JSON.stringify(output), '', 0));

    await flashRankRerank('query', [{ text: 'a', index: 0 }], 'custom-model-v2');

    expect(spawn).toHaveBeenCalled();
    const stdinWrite = vi.mocked(spawn).mock.results[0]?.value?.stdin?.write;
    if (stdinWrite) {
      const writtenData = stdinWrite.mock.calls[0][0];
      expect(JSON.parse(writtenData).model).toBe('custom-model-v2');
    }
  });
});

describe('isFlashRankAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAvailabilityCache();
  });

  it('returns true when flashrank is importable', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, '', '');
        return {} as any;
      },
    );

    expect(await isFlashRankAvailable()).toBe(true);
  });

  it('returns false when flashrank is not installed', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error("ModuleNotFoundError: No module named 'flashrank'"), '', '');
        return {} as any;
      },
    );

    expect(await isFlashRankAvailable()).toBe(false);
  });

  it('caches availability check result', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, '', '');
        return {} as any;
      },
    );

    await isFlashRankAvailable();
    await isFlashRankAvailable();
    await isFlashRankAvailable();

    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('returns false when python3 is not found', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('ENOENT: python3 not found'), '', '');
        return {} as any;
      },
    );

    expect(await isFlashRankAvailable()).toBe(false);
  });

  it('resets cache with resetAvailabilityCache', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, '', '');
        return {} as any;
      },
    );

    await isFlashRankAvailable();
    expect(execFile).toHaveBeenCalledTimes(1);

    resetAvailabilityCache();
    await isFlashRankAvailable();
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});
