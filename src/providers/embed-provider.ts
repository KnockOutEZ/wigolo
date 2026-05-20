/**
 * Embed provider interface — Phase 1 Task 1.3 of v1 engine overhaul.
 *
 * Wraps the existing sentence-transformers subprocess pipeline behind a
 * stable interface so Phase 3 can swap in a native v1 implementation
 * without touching call sites. Today the factory always returns the
 * legacy adapter.
 */
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
  cached = import('../embedding/legacy-provider.js').then(
    async m => {
      const p = new m.LegacyEmbedProvider();
      await p.warmup();
      return p;
    },
    err => { cached = null; throw err; },
  );
  return cached;
}

export function _resetEmbedProviderForTest(): void {
  cached = null;
}
