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

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('../../../src/search/flashrank.js', () => ({
  resetAvailabilityCache: vi.fn(),
}));

import { execSync } from 'node:child_process';

describe('warmup --embeddings flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('installs sentence-transformers when --embeddings flag is passed', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    const { runWarmup } = await import('../../../src/cli/warmup.js');
    const result = await runWarmup(['--embeddings']);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    const hasSentenceTransformers = calls.some(c =>
      c.includes('sentence-transformers') || c.includes('sentence_transformers'),
    );
    expect(hasSentenceTransformers).toBe(true);
  });

  it('installs sentence-transformers when --all flag is passed', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    const { runWarmup } = await import('../../../src/cli/warmup.js');
    const result = await runWarmup(['--all']);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    const hasSentenceTransformers = calls.some(c =>
      c.includes('sentence-transformers') || c.includes('sentence_transformers'),
    );
    expect(hasSentenceTransformers).toBe(true);
  });

  it('skips sentence-transformers without --embeddings flag', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    const { runWarmup } = await import('../../../src/cli/warmup.js');
    await runWarmup([]);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    const hasSentenceTransformers = calls.some(c =>
      c.includes('sentence-transformers'),
    );
    expect(hasSentenceTransformers).toBe(false);
  });

  it('reports embeddings status in WarmupResult', async () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    const { runWarmup } = await import('../../../src/cli/warmup.js');
    const result = await runWarmup(['--embeddings']);

    expect(result.embeddings).toBeDefined();
    expect(['ok', 'failed']).toContain(result.embeddings);
  });

  it('handles sentence-transformers install failure', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('sentence-transformers')) {
        throw new Error('pip install failed');
      }
      return Buffer.from('');
    });

    const { runWarmup } = await import('../../../src/cli/warmup.js');
    const result = await runWarmup(['--embeddings']);

    expect(result.embeddings).toBe('failed');
    expect(result.embeddingsError).toContain('pip install failed');
  });
});
