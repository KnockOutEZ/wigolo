/**
 * Embed provider interface.
 *
 * Stable interface for embedding implementations. The default swapped the
 * sentence-transformers Python subprocess for fastembed (Rust ONNX via
 * Node bindings); the factory now returns FastembedEmbedProvider.
 */
import { createLogger } from '../logger.js';

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

export function getEmbedProvider(): Promise<EmbedProvider> {
  if (cached) return cached;
  cached = import('../embedding/fastembed-provider.js')
    .then(async m => {
      const p = new m.FastembedEmbedProvider();
      await p.warmup();
      log.info('embed provider ready', { provider: 'embed', impl: 'fastembed', modelId: p.modelId, dim: p.dim });
      return p;
    })
    .catch(err => {
      // Clear cache on any failure (import or warmup) so the next call retries.
      cached = null;
      throw err;
    });
  return cached;
}

export function _resetEmbedProviderForTest(): void {
  cached = null;
}
