import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// Type-only: the runtime module is dynamic-imported inside getModel() so the
// native ONNX runtime is NOT mapped into the process at boot (D2 idle-footprint
// contract) — a static import loads the native binding the moment any file in
// the boot chain touches this module.
import type { FlagEmbedding } from 'fastembed';
import type { EmbedProvider } from '../providers/embed-provider.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('embedding');

/**
 * Ensure the fastembed model cache dir (and any missing parents) exists, then
 * return it. fastembed's own `retrieveModel` does a NON-recursive
 * `mkdirSync(cacheDir)`, so on a fresh machine where `${dataDir}` (e.g.
 * `~/.wigolo`) does not exist yet the download throws
 * `ENOENT: mkdir '...\.wigolo\fastembed'` (seen on Windows). Pre-creating the
 * dir recursively makes fastembed's own `existsSync` check pass and skips its
 * broken mkdir.
 */
export function ensureFastembedCacheDir(dataDir: string): string {
  const cacheDir = join(dataDir, 'fastembed');
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/**
 * Remove the fastembed cache dir and recreate it empty — used to clear a
 * partial/corrupt model download (a leftover `.tar.gz` that fastembed will not
 * re-fetch) before retrying.
 */
export function resetFastembedCacheDir(dataDir: string): string {
  rmSync(join(dataDir, 'fastembed'), { recursive: true, force: true });
  return ensureFastembedCacheDir(dataDir);
}

/**
 * True when an error looks like a truncated/corrupt model archive — the field
 * `TAR_BAD_ARCHIVE: Unrecognized archive format` and its decompress cousins.
 * These recover by wiping the partial file and re-downloading; unrelated errors
 * (e.g. a missing native tokenizer binary) do NOT, so they must not match.
 */
export function isCorruptArchiveError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /TAR_BAD_ARCHIVE|Unrecognized archive format|unexpected end of (file|data)|incorrect header check|invalid (tar|gzip)|zlib/i.test(
    msg,
  );
}

/**
 * Run a model init; on a corrupt-archive failure ONLY, reset the cache and try
 * exactly once more. Any other error propagates immediately (a re-download would
 * not fix it). Pure over its injected `init`/`resetCache`, so the retry is tested
 * without touching the network or the native runtime.
 */
export async function initModelWithArchiveRetry<T>(
  init: () => Promise<T>,
  resetCache: () => void,
): Promise<T> {
  try {
    return await init();
  } catch (err) {
    if (!isCorruptArchiveError(err)) throw err;
    resetCache();
    return await init();
  }
}

/** Model id of the bundled fastembed model. */
export const FASTEMBED_EMBED_MODEL_ID = 'BGE-small-en-v1.5';

/**
 * Native ONNX embedding provider using fastembed-rs Node bindings.
 *
 * Model: BGE-small-en-v1.5 (384-dim). First call to `warmup()` downloads
 * the ONNX model to `${dataDir}/fastembed`. Subsequent runs reuse the cache.
 * Replaces the legacy sentence-transformers Python subprocess.
 */
export class FastembedEmbedProvider implements EmbedProvider {
  private model: FlagEmbedding | null = null;
  private modelPromise: Promise<FlagEmbedding> | null = null;
  /** Bumped by `dispose()`; a load that resolves late must not store weights. */
  private loadGeneration = 0;
  /** Generation of the in-flight load in `modelPromise`. */
  private modelPromiseGeneration = -1;
  /** In-flight `embed()` calls; `dispose()` must not release under one. */
  private embedsInFlight = 0;
  /** Resolved by the `embed()` that brings the counter back to zero. */
  private drainWaiter: { promise: Promise<void>; resolve: () => void } | null = null;
  /** Sessions from a load that resolved after dispose, held until the last embed ends. */
  private readonly deferredReleases: FlagEmbedding[] = [];
  readonly modelId: string;
  readonly dim: number;

  constructor() {
    this.modelId = FASTEMBED_EMBED_MODEL_ID;
    this.dim = 384;
  }

  async warmup(): Promise<void> {
    await this.getModel();
  }

  /**
   * Release the ONNX session behind a loaded model. `session` is private in
   * the fastembed typings, so it is read through a narrow cast. Best-effort:
   * a failed release is logged and never thrown.
   */
  private async releaseSession(model: FlagEmbedding | null): Promise<void> {
    if (!model) return;
    const session = (model as unknown as { session?: { release?: () => Promise<unknown> } }).session;
    if (typeof session?.release !== 'function') return;
    try {
      await session.release();
    } catch (err) {
      log.debug('embedding session release failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The waiter for the in-flight counter; armed by `dispose()`, cleared at zero. */
  private drain(): Promise<void> {
    if (this.drainWaiter) return this.drainWaiter.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    this.drainWaiter = { promise, resolve };
    return promise;
  }

  /**
   * Release the resident ONNX model. The next call loads it again from the
   * cache. A call already in flight settles first — running on a released
   * session would crash — then the session is released. A load that is still
   * in flight is discarded, so a late resolve cannot hold the weights; its own
   * session is released when it resolves.
   */
  async dispose(): Promise<void> {
    this.loadGeneration += 1;
    const model = this.model;
    this.model = null;
    this.modelPromise = null;
    this.modelPromiseGeneration = -1;
    if (this.embedsInFlight > 0) await this.drain();
    await this.releaseSession(model);
  }

  private getModel(): Promise<FlagEmbedding> {
    if (this.model) return Promise.resolve(this.model);
    if (this.modelPromise) return this.modelPromise;
    log.info('Loading embedding model', { modelId: this.modelId });
    const dataDir = getConfig().dataDir;
    const cacheDir = ensureFastembedCacheDir(dataDir);
    const generation = this.loadGeneration;
    const promise = import('fastembed')
      .then(({ FlagEmbedding, EmbeddingModel }) =>
        initModelWithArchiveRetry(
          () => FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir }),
          () => resetFastembedCacheDir(dataDir),
        ),
      )
      .then(async m => {
      if (generation !== this.loadGeneration) {
        // A resolve that landed after the release is never published. If no
        // call is using it, release it now. Otherwise the last in-flight embed
        // releases it in its finally block, after it stops using the session.
        if (this.embedsInFlight === 0) {
          await this.releaseSession(m);
        } else {
          this.deferredReleases.push(m);
        }
        return m;
      }
      this.model = m;
      log.info('Embedding model ready', { modelId: this.modelId, dim: this.dim });
      return m;
    }).catch(err => {
      if (this.modelPromiseGeneration === generation) {
        this.modelPromise = null;
        this.modelPromiseGeneration = -1;
      }
      throw err;
    });
    this.modelPromise = promise;
    this.modelPromiseGeneration = generation;
    return promise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    this.embedsInFlight += 1;
    try {
      const model = await this.getModel();
      const out: Float32Array[] = [];
      for await (const batch of model.embed(texts, texts.length)) {
        for (const vec of batch) {
          out.push(Float32Array.from(vec));
        }
      }
      return out;
    } finally {
      this.embedsInFlight -= 1;
      if (this.embedsInFlight === 0) {
        const deferred = this.deferredReleases.splice(0);
        for (const model of deferred) {
          await this.releaseSession(model);
        }
        if (this.drainWaiter) {
          const waiter = this.drainWaiter;
          this.drainWaiter = null;
          waiter.resolve();
        }
      }
    }
  }
}
