/**
 * Embed provider interface.
 *
 * Stable interface for embedding implementations. The default switched the
 * sentence-transformers Python subprocess for fastembed (Rust ONNX via
 * Node bindings); the factory now returns FastembedEmbedProvider for
 * English queries and MultilingualEmbedProvider for Arabic/multilingual
 * queries (controlled by `embedding.model` in config).
 */
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';

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
let cachedKey: string | null = null;

/**
 * Resolve the active embed provider based on `config.embedding.model`.
 *
 * Supported values:
 *   - "fastembed"  (default, English-only): BGE-small-en-v1.5
 *   - "multilingual": Xenova/paraphrase-multilingual-MiniLM-L12-v2
 *                   (117M, 384-dim, Arabic-aware, ~150ms per query on CPU)
 *
 * The provider is created once per session and cached. Changing the
 * config requires a daemon restart.
 */
export function getEmbedProvider(): Promise<EmbedProvider> {
  const config = getConfig() as { embedding?: { model?: string } };
  const requestedModel = config.embedding?.model || "fastembed";
  if (cached && cachedKey === requestedModel) return cached;

  cached = (async () => {
    if (requestedModel === "multilingual") {
      const m = await import("../embedding/multilingual-embed-provider.js");
      const p = new m.MultilingualEmbedProvider();
      await p.warmup();
      log.info("embed provider ready", {
        provider: "embed",
        impl: "multilingual",
        modelId: p.modelId,
        dim: p.dim,
      });
      return p;
    }
    // Default: fastembed (English BGE-small-en-v1.5).
    const m = await import("../embedding/fastembed-provider.js");
    const p = new m.FastembedEmbedProvider();
    await p.warmup();
    log.info("embed provider ready", {
      provider: "embed",
      impl: "fastembed",
      modelId: p.modelId,
      dim: p.dim,
    });
    return p;
  })().catch(err => {
    cached = null;
    cachedKey = null;
    throw err;
  });
  cachedKey = requestedModel;
  return cached;
}

export function _resetEmbedProviderForTest(): void {
  cached = null;
  cachedKey = null;
}
