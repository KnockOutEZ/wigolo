import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    createWriteStream: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: vi.fn(),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/test-wigolo' })),
}));

vi.mock('../../../src/search/reranker/download.js', () => ({
  downloadModelAssets: vi.fn().mockResolvedValue({
    modelPath: '/tmp/model.onnx',
    tokenizerPath: '/tmp/tokenizer.json',
    configPath: '/tmp/tokenizer_config.json',
  }),
}));

vi.mock('../../../src/search/reranker/onnx.js', () => ({
  onnxRerank: vi.fn().mockResolvedValue([{ index: 0, score: 0.5 }]),
}));

import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup } from '../../../src/cli/warmup.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../../../src/searxng/bootstrap.js';
import { downloadModelAssets } from '../../../src/search/reranker/download.js';
import { onnxRerank } from '../../../src/search/reranker/onnx.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
const failWith = (msg: string) => ({ code: 1, stdout: '', stderr: msg, timedOut: false });

const argsOf = (call: unknown[]): string[] => (call[1] as string[]) ?? [];
const includesArg = (call: unknown[], needle: string): boolean =>
  argsOf(call).some((a) => String(a).includes(needle));

describe('runWarmup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
  });

  it('installs Playwright chromium', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(runCommand).toHaveBeenCalledWith(
      'npx',
      ['playwright', 'install', 'chromium'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(result.playwright).toBe('ok');
  });

  it('reports playwright failure without throwing', async () => {
    vi.mocked(runCommand).mockResolvedValue(failWith('install failed'));
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(result.playwright).toBe('failed');
    expect(result.playwrightError).toBe('install failed');
  });

  it('reports searxng already ready', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(result.searxng).toBe('ready');
    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
  });

  it('bootstraps searxng when python available and not ready', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);
    vi.mocked(bootstrapNativeSearxng).mockResolvedValue(undefined);

    const result = await runWarmup();

    expect(bootstrapNativeSearxng).toHaveBeenCalledWith('/tmp/test-wigolo');
    expect(result.searxng).toBe('bootstrapped');
  });

  it('reports searxng bootstrap failure', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);
    vi.mocked(bootstrapNativeSearxng).mockRejectedValue(new Error('pip failed'));

    const result = await runWarmup();

    expect(result.searxng).toBe('failed');
    expect(result.searxngError).toBe('pip failed');
  });

  it('reports no python available', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(false);

    const result = await runWarmup();

    expect(result.searxng).toBe('no_python');
  });
});

const mockFetchNoop = () => {
  const headers = new Headers({ 'content-length': '0' });
  const resp = {
    ok: true,
    status: 200,
    headers,
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp as unknown as Response);
};

describe('runWarmup with flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    mockFetchNoop();
  });

  it('accepts flags parameter without breaking existing behavior', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup([]);

    expect(result.playwright).toBe('ok');
    expect(result.searxng).toBe('ready');
  });

  it('accepts no arguments (backward compatible)', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(result.playwright).toBe('ok');
  });

  it('installs trafilatura when --trafilatura flag is passed', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    await runWarmup(['--trafilatura']);

    const calls = vi.mocked(runCommand).mock.calls;
    const pipCall = calls.find((c) => includesArg(c, 'trafilatura'));
    expect(pipCall).toBeDefined();
    expect(argsOf(pipCall!)).toEqual(expect.arrayContaining(['-m', 'pip', 'install']));
  });

  it('installs trafilatura when --all flag is passed', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    await runWarmup(['--all']);

    const calls = vi.mocked(runCommand).mock.calls;
    const pipCall = calls.find((c) => includesArg(c, 'trafilatura'));
    expect(pipCall).toBeDefined();
  });

  it('does not install trafilatura when no flag is passed', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    await runWarmup([]);

    const calls = vi.mocked(runCommand).mock.calls;
    const pipCall = calls.find((c) => includesArg(c, 'trafilatura'));
    expect(pipCall).toBeUndefined();
  });

  it('handles trafilatura install failure gracefully', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args.some((a) => String(a).includes('trafilatura'))) {
        return failWith('pip install failed: network error');
      }
      return ok;
    });

    const result = await runWarmup(['--trafilatura']);
    expect(result.playwright).toBe('ok');
  });
});

describe('warmup --reranker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
    vi.mocked(downloadModelAssets).mockResolvedValue({
      modelPath: '/tmp/model.onnx',
      tokenizerPath: '/tmp/tokenizer.json',
      configPath: '/tmp/tokenizer_config.json',
    });
    vi.mocked(onnxRerank).mockResolvedValue([{ index: 0, score: 0.5 }]);
  });

  it('pip-installs tokenizers + onnxruntime when --reranker passed', async () => {
    const result = await runWarmup(['--reranker']);

    const calls = vi.mocked(runCommand).mock.calls;
    const tokCall = calls.find((c) => includesArg(c, 'tokenizers'));
    const ortCall = calls.find((c) => includesArg(c, 'onnxruntime'));
    expect(tokCall).toBeDefined();
    expect(ortCall).toBeDefined();
    expect(argsOf(tokCall!)).toEqual(expect.arrayContaining(['-m', 'pip', 'install']));
    expect(downloadModelAssets).toHaveBeenCalled();
    expect(onnxRerank).toHaveBeenCalled();
    expect(result.reranker).toBe('ok');
  });

  it('--all flag includes reranker installation', async () => {
    const result = await runWarmup(['--all']);

    const calls = vi.mocked(runCommand).mock.calls;
    const tokCall = calls.find((c) => includesArg(c, 'tokenizers'));
    expect(tokCall).toBeDefined();
    expect(downloadModelAssets).toHaveBeenCalled();
    expect(result.reranker).toBe('ok');
  });

  it('--all combines sentence-transformers into the reranker pip call (single resolver pass)', async () => {
    await runWarmup(['--all']);

    const calls = vi.mocked(runCommand).mock.calls;
    const combinedCall = calls.find(
      (c) =>
        includesArg(c, 'tokenizers') &&
        includesArg(c, 'onnxruntime') &&
        includesArg(c, 'sentence-transformers'),
    );
    expect(combinedCall).toBeDefined();
  });

  it('reports failure when pip install fails', async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args.some((a) => String(a).includes('tokenizers'))) {
        return failWith('pip resolver error');
      }
      return ok;
    });

    const result = await runWarmup(['--reranker']);

    expect(result.reranker).toBe('failed');
    expect(result.rerankerError).toContain('pip resolver error');
    expect(downloadModelAssets).not.toHaveBeenCalled();
  });

  it('reports failure when download fails', async () => {
    vi.mocked(downloadModelAssets).mockRejectedValueOnce(new Error('SHA-256 mismatch'));

    const result = await runWarmup(['--reranker']);

    expect(result.reranker).toBe('failed');
    expect(result.rerankerError).toContain('SHA-256');
  });

  it('does not install reranker when flag not passed', async () => {
    const result = await runWarmup([]);

    expect(downloadModelAssets).not.toHaveBeenCalled();
    expect(result.reranker).toBeUndefined();
  });

  it('reports failure when smoke rerank fails', async () => {
    vi.mocked(onnxRerank).mockRejectedValueOnce(new Error('ONNX session init failed'));

    const result = await runWarmup(['--reranker']);

    expect(result.reranker).toBe('failed');
    expect(result.rerankerError).toContain('ONNX session');
  });
});
