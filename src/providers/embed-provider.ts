/**
 * Embed provider interface.
 *
 * Stable interface for embedding implementations. The default swapped the
 * sentence-transformers Python subprocess for fastembed (Rust ONNX via
 * Node bindings); the factory now returns FastembedEmbedProvider.
 */
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { createIdleUnload, withIdleTracking, type IdleUnload } from './idle-unload.js';

const log = createLogger('providers');

export interface EmbedProvider {
  /** Embed a batch of strings; returns one Float32Array per input. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Dimensionality of embeddings produced by this provider. */
  readonly dim: number;
  /** Model identifier (for cache invalidation / provenance). */
  readonly modelId: string;
}

let cached: Promise<EmbedProvider> | null = null;
/** The real provider behind `cached`. `cached` may hand out an idle wrapper. */
let instance: EmbedProvider | null = null;
/** The handle `cached` returned when idle tracking wrapped the provider. */
let handle: EmbedProvider | null = null;
let idle: IdleUnload | null = null;

/**
 * Same guard as the rerank factory: bumped whenever the factory state is thrown
 * away. A factory call remembers the value at entry, so a completion from an
 * older generation belongs to a lookup that was dropped and cannot publish over
 * the one that replaced it.
 */
let generation = 0;

function withIdleUnload(provider: EmbedProvider, clock: IdleUnload): EmbedProvider {
  return withIdleTracking(provider, clock, 'embed');
}

export function getEmbedProvider(): Promise<EmbedProvider> {
  if (cached) return cached;
  const config = getConfig();
  const startedAt = generation;
  cached = import('../embedding/fastembed-provider.js')
    .then(async m => {
      const p = new m.FastembedEmbedProvider();
      await p.warmup();
      if (generation !== startedAt) {
        // A full dispose landed while this warmup was in flight. The factory
        // state belongs to a newer generation now, so this provider can only be
        // released — never published — and the lookup that waited on it fails.
        await releaseEmbedProvider(p);
        throw new Error('embed provider disposed during initialization');
      }
      log.info('embed provider ready', { provider: 'embed', impl: 'fastembed', modelId: p.modelId, dim: p.dim });
      instance = p;
      idle = createIdleUnload({
        timeoutMs: config.embeddingIdleTimeoutMs,
        label: 'embed',
        onIdle: () => disposeEmbedProvider(p),
      });
      // The model is already loaded by the eager warmup above. Start the
      // countdown now, or it would wait for an embed() call that may never come.
      idle.touch();
      const wrapped = withIdleUnload(p, idle);
      handle = wrapped;
      return wrapped;
    })
    .catch(err => {
      // Clear cache on any failure (import or warmup) so the next call retries,
      // but only while this generation still owns it: a newer lookup must not be
      // clobbered by an older lookup's failure.
      if (generation === startedAt) {
        cached = null;
        instance = null;
      }
      throw err;
    });
  return cached;
}

export function _resetEmbedProviderForTest(): void {
  generation += 1;
  idle?.cancel();
  idle = null;
  cached = null;
  instance = null;
  handle = null;
}

/** Release a specific provider. Errors stay inside this best-effort helper. */
async function releaseEmbedProvider(provider: EmbedProvider): Promise<void> {
  try {
    const disposable = provider as unknown as { dispose?: () => Promise<void> };
    if (typeof disposable.dispose === 'function') await disposable.dispose();
  } catch (err) {
    log.debug('embed dispose failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Best-effort release of the cached embed provider. Fastembed exposes no
 * explicit dispose, so dropping the reference is what frees the model; a
 * provider that grows one later is called here.
 *
 * `expected` binds the release to the provider that armed the clock. A handle
 * retained from an older provider therefore cannot tear down a newer one. Such
 * a stale handle still releases the provider behind it, because that provider
 * may have reloaded its model after the handle re-armed the old clock.
 * A full dispose also invalidates an initialization still in flight, so its
 * completion can no longer publish itself: it releases only what it built.
 */
export async function disposeEmbedProvider(expected?: EmbedProvider): Promise<void> {
  if (expected && instance !== expected && expected !== handle) {
    // Stale handle: release only the provider it belongs to. The current
    // factory state and countdown stay as they are, and the generation is not
    // bumped — this handle belongs to a lookup that was already replaced.
    await releaseEmbedProvider(expected);
    return;
  }
  generation += 1;
  idle?.cancel();
  idle = null;
  const provider = instance;
  instance = null;
  handle = null;
  cached = null;
  if (!provider) return;
  await releaseEmbedProvider(provider);
}