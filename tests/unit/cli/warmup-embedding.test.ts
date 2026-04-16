import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    dataDir: '/tmp/wigolo-test',
    embeddingModel: 'BAAI/bge-small-en-v1.5',
  }),
}));

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  getBootstrapState: vi.fn().mockReturnValue({ status: 'ready' }),
  checkPythonAvailable: vi.fn().mockReturnValue(true),
  bootstrapNativeSearxng: vi.fn(),
}));

vi.mock('../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockImplementation((p) => String(p).endsWith('lightpanda')),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock('../../../src/search/flashrank.js', () => ({
  resetAvailabilityCache: vi.fn(),
}));

import { runCommand } from '../../../src/cli/tui/run-command.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };

const hasPkg = (needle: string) =>
  vi.mocked(runCommand).mock.calls.some((c) => (c[1] as string[]).some((a) => String(a).includes(needle)));

describe('warmup --embeddings flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
  });

  it('installs sentence-transformers when --embeddings flag is passed', async () => {
    const { runWarmup } = await import('../../../src/cli/warmup.js');
    await runWarmup(['--embeddings']);

    expect(hasPkg('sentence-transformers') || hasPkg('sentence_transformers')).toBe(true);
  });

  it('installs sentence-transformers when --all flag is passed', async () => {
    const { runWarmup } = await import('../../../src/cli/warmup.js');
    await runWarmup(['--all']);

    expect(hasPkg('sentence-transformers') || hasPkg('sentence_transformers')).toBe(true);
  });

  it('skips sentence-transformers without --embeddings flag', async () => {
    const { runWarmup } = await import('../../../src/cli/warmup.js');
    await runWarmup([]);

    expect(hasPkg('sentence-transformers')).toBe(false);
  });

  it('reports embeddings status in WarmupResult', async () => {
    const { runWarmup } = await import('../../../src/cli/warmup.js');
    const result = await runWarmup(['--embeddings']);

    expect(result.embeddings).toBeDefined();
    expect(['ok', 'failed']).toContain(result.embeddings);
  });

  it('handles sentence-transformers install failure', async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args.some((a) => String(a).includes('sentence-transformers'))) {
        return { code: 1, stdout: '', stderr: 'pip install failed', timedOut: false };
      }
      return ok;
    });

    const { runWarmup } = await import('../../../src/cli/warmup.js');
    const result = await runWarmup(['--embeddings']);

    expect(result.embeddings).toBe('failed');
    expect(result.embeddingsError).toContain('pip install failed');
  });
});
