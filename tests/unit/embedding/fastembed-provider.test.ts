// Runtime tests require huggingface.co network for ONNX download on first run.
// Gate them via RUN_FASTEMBED=1 env so CI/sandbox environments stay green.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FastembedEmbedProvider,
  ensureFastembedCacheDir,
  resetFastembedCacheDir,
  isCorruptArchiveError,
  initModelWithArchiveRetry,
} from '../../../src/embedding/fastembed-provider.js';

describe('FastembedEmbedProvider (static)', () => {
  it('exposes BGE-small modelId and 384-dim without warmup', () => {
    const p = new FastembedEmbedProvider();
    expect(p.modelId).toMatch(/bge.?small/i);
    expect(p.dim).toBe(384);
  });
});

describe('ensureFastembedCacheDir (B: recursive cache dir)', () => {
  it('creates the fastembed cache dir AND its missing parents', () => {
    // WHY (field bug, Windows): fastembed's own retrieveModel does a
    // NON-recursive `mkdirSync(cacheDir)`, so when ~/.wigolo does not exist yet
    // the download throws `ENOENT: mkdir '...\.wigolo\fastembed'`. wigolo must
    // pre-create the dir and its parent chain before handing off to fastembed.
    const base = mkdtempSync(join(tmpdir(), 'wigolo-fe-'));
    const dataDir = join(base, 'does-not-exist-yet', 'wigolo');
    try {
      const dir = ensureFastembedCacheDir(dataDir);
      expect(dir).toBe(join(dataDir, 'fastembed'));
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('is idempotent when the cache dir already exists', () => {
    const base = mkdtempSync(join(tmpdir(), 'wigolo-fe-'));
    try {
      expect(() => ensureFastembedCacheDir(base)).not.toThrow();
      expect(() => ensureFastembedCacheDir(base)).not.toThrow();
      expect(existsSync(join(base, 'fastembed'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('isCorruptArchiveError (3c: detect a partial/corrupt model download)', () => {
  it('flags the field TAR_BAD_ARCHIVE and related decompress failures', () => {
    // WHY (field bug, Linux): a truncated/HTML-error model `.tar.gz` throws
    // `TAR_BAD_ARCHIVE: Unrecognized archive format`. These are recoverable by
    // wiping the partial file and re-downloading.
    expect(isCorruptArchiveError(new Error('TAR_BAD_ARCHIVE: Unrecognized archive format'))).toBe(true);
    expect(isCorruptArchiveError(new Error('unexpected end of file'))).toBe(true);
    expect(isCorruptArchiveError(new Error('incorrect header check'))).toBe(true);
  });

  it('does NOT flag unrelated errors (a re-download would not help)', () => {
    expect(isCorruptArchiveError(new Error("Cannot find module '@anush008/tokenizers-linux-arm64-gnu'"))).toBe(false);
    expect(isCorruptArchiveError(new Error('some unrelated failure'))).toBe(false);
  });
});

describe('initModelWithArchiveRetry (3c)', () => {
  it('resets the cache and retries ONCE on a corrupt-archive error, then succeeds', async () => {
    let calls = 0;
    const reset = vi.fn();
    const init = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('TAR_BAD_ARCHIVE: Unrecognized archive format');
      return 'MODEL';
    });
    const m = await initModelWithArchiveRetry(init, reset);
    expect(m).toBe('MODEL');
    expect(init).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry or reset on a non-archive error', async () => {
    const reset = vi.fn();
    const init = vi.fn(async () => {
      throw new Error("Cannot find module 'x'");
    });
    await expect(initModelWithArchiveRetry(init, reset)).rejects.toThrow(/Cannot find module/);
    expect(init).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it('does not reset on first-try success', async () => {
    const reset = vi.fn();
    const init = vi.fn(async () => 'M');
    await initModelWithArchiveRetry(init, reset);
    expect(init).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });
});

describe('resetFastembedCacheDir (3c)', () => {
  it('removes a partial download and returns a fresh cache dir', () => {
    const base = mkdtempSync(join(tmpdir(), 'wigolo-fe-'));
    try {
      const dir = ensureFastembedCacheDir(base);
      writeFileSync(join(dir, 'BGESmallENV15.tar.gz'), 'partial-garbage');
      const dir2 = resetFastembedCacheDir(base);
      expect(dir2).toBe(dir);
      expect(existsSync(join(dir, 'BGESmallENV15.tar.gz'))).toBe(false);
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.env.RUN_FASTEMBED)('FastembedEmbedProvider (runtime, RUN_FASTEMBED=1)', () => {
  let provider: FastembedEmbedProvider;
  beforeAll(async () => {
    provider = new FastembedEmbedProvider();
    await provider.warmup();
  }, 120_000);

  it('embeds a single string', async () => {
    const [vec] = await provider.embed(['hello world']);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(provider.dim);
  });

  it('embeds a batch', async () => {
    const vecs = await provider.embed(['foo', 'bar', 'baz']);
    expect(vecs).toHaveLength(3);
    vecs.forEach(v => expect(v.length).toBe(provider.dim));
  });

  it('similar strings have higher cosine similarity than dissimilar', async () => {
    const [a, b, c] = await provider.embed([
      'TypeScript is a typed superset of JavaScript',
      'TS adds types to JavaScript',
      'The quick brown fox jumps over the lazy dog',
    ]);
    const cos = (x: Float32Array, y: Float32Array): number => {
      let s = 0, nx = 0, ny = 0;
      for (let i = 0; i < x.length; i++) { s += x[i] * y[i]; nx += x[i] ** 2; ny += y[i] ** 2; }
      return s / (Math.sqrt(nx) * Math.sqrt(ny));
    };
    expect(cos(a, b)).toBeGreaterThan(cos(a, c));
  });

  it('exposes stable modelId', () => {
    expect(provider.modelId).toMatch(/bge|nomic/i);
  });

  it('returns empty array for empty input', async () => {
    const out = await provider.embed([]);
    expect(out).toEqual([]);
  });
});
