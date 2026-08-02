import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(),
    chmodSync: vi.fn(),
  };
});

vi.mock('../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false }),
}));

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: () => true,
  getBootstrapState: () => ({ status: 'ready', searxngPath: '/tmp/wigolo/searxng' }),
  bootstrapNativeSearxng: vi.fn(),
}));

vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: vi.fn().mockResolvedValue([{ id: '0', score: 0.5 }]),
  })),
}));

vi.mock('../../../src/embedding/fastembed-provider.js', () => {
  const FastembedEmbedProvider = vi.fn(function (this: Record<string, unknown>) {
    this.modelId = 'BGE-small-en-v1.5';
    this.dim = 384;
    this.warmup = vi.fn().mockResolvedValue(undefined);
    this.embed = vi.fn().mockResolvedValue([new Float32Array(384).fill(0.1)]);
  });
  return { FastembedEmbedProvider };
});

const mockStart = vi.fn();
const mockStop = vi.fn();

vi.mock('../../../src/searxng/process.js', () => ({
  SearxngProcess: vi.fn(function (this: { start: typeof mockStart; stop: typeof mockStop }) {
    this.start = mockStart;
    this.stop = mockStop;
  }),
  isProcessAlive: () => false,
}));

const originalFetch = global.fetch;
const fetchMock = vi.fn();

import { runWarmup } from '../../../src/cli/warmup.js';

describe('runWarmup verify step', () => {
  let outBuffer = '';
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    outBuffer = '';
    resetConfig();
    vi.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    const capture = (chunk: unknown) => { outBuffer += String(chunk); return true; };
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    mockStart.mockResolvedValue('http://127.0.0.1:8888');
    mockStop.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: 'x' }, { url: 'y' }] }),
    });
  });

  afterEach(() => {
    resetConfig();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    global.fetch = originalFetch;
  });

  it('runs verify step when --verify flag passed', async () => {
    await runWarmup(['--verify', '--plain']);
    expect(outBuffer).toMatch(/Verifying setup/);
    expect(mockStart).toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalled();
  });

  it('runs verify step when --all flag passed', async () => {
    await runWarmup(['--all', '--plain']);
    expect(outBuffer).toMatch(/Verifying setup/);
  });

  it('skips the verify step under --all when --skip-verify is passed (init runs doctor instead)', async () => {
    await runWarmup(['--all', '--skip-verify', '--plain']);
    expect(outBuffer).not.toMatch(/Verifying setup/);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('does not run verify without flag', async () => {
    await runWarmup(['--plain']);
    expect(outBuffer).not.toMatch(/Verifying setup/);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('verify reports SearXNG failure when start returns null', async () => {
    mockStart.mockResolvedValue(null);
    await runWarmup(['--verify', '--plain']);
    expect(outBuffer).toMatch(/Search engine.*failed to start/i);
  });

  it('verify prints connect instructions on success', async () => {
    await runWarmup(['--verify', '--plain']);
    expect(outBuffer).toMatch(/claude mcp add wigolo/);
  });

  it('verify stops SearXNG after checks complete', async () => {
    await runWarmup(['--verify', '--plain']);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});
