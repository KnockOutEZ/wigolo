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

function withIdleUnload(provider: EmbedProvider, clock: IdleUnload): EmbedProvider {
  return withIdleTracking(provider, clock, 'embed');
}

export function getEmbedProvider(): Promise<EmbedProvider> {
  if (cached) return cached;
  const config = getConfig();
  cached = import('../embedding/fastembed-provider.js')
    .then(async m => {
      const p = new m.FastembedEmbedProvider();
      await p.warmup();
      log.info('embed provider ready', { provider: 'embed', impl: 'fastembed', modelId: p.modelId, dim: p.dim });
      instance = p;
      idle = createIdleUnload({
        timeoutMs: config.embeddingIdleTimeoutMs,
        label: 'embed',
        onIdle: () => disposeEmbedProvider(p),
      });
      const wrapped = withIdleUnload(p, idle);
      handle = wrapped;
      return wrapped;
    })
    .catch(err => {
      // Clear cache on any failure (import or warmup) so the next call retries.
      cached = null;
      instance = null;
      throw err;
    });
  return cached;
}

export function _resetEmbedProviderForTest(): void {
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
 */
export async function disposeEmbedProvider(expected?: EmbedProvider): Promise<void> {
  if (expected && instance !== expected && expected !== handle) {
    // Stale handle: release only the provider it belongs to. The current
    // factory state and countdown stay as they are.
    await releaseEmbedProvider(expected);
    return;
  }
  idle?.cancel();
  idle = null;
  const provider = instance;
  instance = null;
  handle = null;
  cached = null;
  if (!provider) return;
  await releaseEmbedProvider(provider);
}