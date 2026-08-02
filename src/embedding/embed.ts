import type { EmbedProvider } from '../providers/embed-provider.js';
import {
  getVectorStore,
  type VectorStore,
  type VectorRecord,
} from '../providers/vector-store.js';
import {
  updateCacheEmbedding,
  getAllEmbeddings,
  normalizeUrl,
} from '../cache/store.js';
import { FastembedEmbedProvider } from './fastembed-provider.js';
import { createLogger } from '../logger.js';

const log = createLogger('embedding');

export interface SimilarResult {
  url: string;
  score: number;
}

/**
 * Index shim exposed by `getIndex()` for callers that still need
 * lightweight size/membership checks. Kept narrow so future stores can
 * implement it without dragging in extra surface area.
 */
export interface IndexView {
  size(): number;
  has(url: string): boolean;
}

/**
 * Embedding service backed by the native fastembed (ONNX) provider and
 * the sqlite-vec VectorStore.
 *
 * The in-memory VectorIndex was replaced with the sqlite-vec backed
 * store accessed via getVectorStore(). The public surface (init /
 * embedAndStore / embedAsync / findSimilar / getIndex / isAvailable /
 * shutdown) is unchanged so callers in server.ts, tools/fetch.ts,
 * research/pipeline.ts, search/find-similar.ts, and the legacy SearXNG
 * orchestrator continue to work without modification.
 */
/**
 * Lazy-provider policy (design D2): the ONNX provider is probed on FIRST USE,
 * never at boot. A failed load memoizes for RETRY_MEMO_MS so an immediate
 * retry is cheap; after MAX_LOAD_ATTEMPTS failures the provider latches off for
 * the process with an actionable error.
 */
const RETRY_MEMO_MS = 60_000;
const MAX_LOAD_ATTEMPTS = 3;

export class EmbeddingService {
  private provider: EmbedProvider;
  private store: VectorStore | null = null;
  private knownUrls = new Set<string>();
  private available = false;
  private providerVerified = false;

  // Lazy provider-load state.
  private readyPromise: Promise<boolean> | null = null;
  private loadAttempts = 0;
  private lastFailureAt = 0;
  private latchedOff = false;

  constructor(provider?: EmbedProvider) {
    this.provider = provider ?? new FastembedEmbedProvider();
  }

  /**
   * Boot init: provisions the vector store, runs the legacy-embedding
   * migration, and surfaces sqlite-vec init failures — WITHOUT touching the
   * ONNX runtime. The provider is probed lazily on first use via
   * ensureProviderReady(); this is the ~150-200MB idle-footprint win.
   */
  async init(): Promise<void> {
    try {
      this.store = await getVectorStore();

      // Migrate any embeddings persisted in url_cache (pre-Phase-5 layout)
      // into the sqlite-vec backed store on first use. Skips on hit so
      // re-init is cheap.
      try {
        const existingSize = await this.store.size();
        if (existingSize === 0) {
          await this.migrateLegacyEmbeddings();
        } else {
          // Seed knownUrls from the store so embedAndStore can avoid
          // unnecessary re-upserts when content has not changed.
          // The current store has no list API, so we leave knownUrls empty
          // and rely on upsert idempotency.
        }
      } catch (err) {
        log.warn('embedding migration check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      this.available = true;
    } catch (err) {
      log.error('EmbeddingService init failed', { error: String(err) });
      this.available = false;
    }
  }

  /**
   * Load the embedding provider on first use. Memoized: concurrent callers
   * share one in-flight probe, and a verified provider never re-probes.
   * A failed load memoizes for RETRY_MEMO_MS (immediate retries are cheap);
   * after MAX_LOAD_ATTEMPTS failures the provider latches off for the process.
   * Returns true when the provider is ready to embed.
   */
  async ensureProviderReady(): Promise<boolean> {
    if (this.providerVerified) return true;
    if (this.latchedOff) return false;
    if (this.readyPromise) return this.readyPromise;

    // Within the memo window after a failure, do not re-probe.
    if (this.loadAttempts > 0 && Date.now() - this.lastFailureAt < RETRY_MEMO_MS) {
      return false;
    }

    this.readyPromise = this.loadProvider().finally(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  private async loadProvider(): Promise<boolean> {
    this.loadAttempts += 1;
    log.info('loading embedding model (first use — downloads ~30MB if not cached)', {
      attempt: this.loadAttempts,
    });
    try {
      await this.provider.embed(['embedding service probe']);
      this.providerVerified = true;
      log.info('embedding provider verified', {
        modelId: this.provider.modelId,
        dim: this.provider.dim,
      });
      return true;
    } catch (err) {
      this.lastFailureAt = Date.now();
      const message = err instanceof Error ? err.message : String(err);
      if (this.loadAttempts >= MAX_LOAD_ATTEMPTS) {
        this.latchedOff = true;
        this.available = false;
        log.error(
          'embedding provider failed to load after repeated attempts — embeddings disabled; run `wigolo warmup --embeddings` to install the model',
          { error: message, attempts: this.loadAttempts },
        );
      } else {
        log.warn('embedding provider load failed — will retry on next use', {
          error: message,
          attempt: this.loadAttempts,
        });
      }
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available && !this.latchedOff;
  }

  setAvailable(value: boolean): void {
    this.available = value;
  }

  /** Backwards-compat alias preserved for callers that gated on subprocess readiness. */
  isSubprocessReady(): boolean {
    return this.providerVerified;
  }

  /**
   * Lightweight index view. Returns `size` from the backing VectorStore and
   * `has` from a local URL-cache populated by embedAndStore. Callers that
   * need richer access should consume the VectorStore directly via
   * `getVectorStore()`.
   */
  getIndex(): IndexView {
    const knownUrls = this.knownUrls;
    const store = this.store;
    return {
      size: () => (store ? this.cachedSize : knownUrls.size),
      has: (url: string) => knownUrls.has(url),
    };
  }

  /**
   * Cached size from the store, refreshed after upserts. Reads from a
   * VectorStore would be async; getIndex().size() callers expect a
   * synchronous return so we maintain this counter.
   */
  private cachedSize = 0;

  async embedAndStore(url: string, markdown: string): Promise<void> {
    if (!this.available) {
      log.debug('embedding skipped: service not available', { url });
      return;
    }

    // Lazy provider load on first use (hoisted here so fetch/research/search
    // callers get it without a per-call-site change).
    if (!(await this.ensureProviderReady())) {
      log.debug('embedding skipped: provider not ready', { url });
      return;
    }

    try {
      const [vector] = await this.provider.embed([markdown]);
      if (!vector || vector.length === 0) {
        log.warn('embedding returned empty vector', { url });
        return;
      }

      const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
      const model = this.provider.modelId;
      const dims = vector.length;

      let normalizedUrl: string;
      try {
        normalizedUrl = normalizeUrl(url);
      } catch {
        normalizedUrl = url;
      }

      updateCacheEmbedding(normalizedUrl, buffer, model, dims);

      if (this.store) {
        const record: VectorRecord = {
          id: normalizedUrl,
          vector,
          metadata: { url: normalizedUrl, contentHash: '', modelId: model },
        };
        await this.store.upsert([record]);
        if (!this.knownUrls.has(normalizedUrl)) {
          this.knownUrls.add(normalizedUrl);
          this.cachedSize += 1;
        }
      }

      log.debug('embedded and stored', { url: normalizedUrl, dims });
    } catch (err) {
      log.warn('embedAndStore failed', { url, error: String(err) });
    }
  }

  embedAsync(url: string, markdown: string): void {
    if (!this.available) return;

    this.embedAndStore(url, markdown).catch(err => {
      log.warn('async embedding failed', { url, error: String(err) });
    });
  }

  async findSimilar(
    queryText: string,
    topK: number,
    excludeUrls?: Set<string>,
  ): Promise<SimilarResult[]> {
    if (!this.available || !this.store) {
      return [];
    }
    if (this.cachedSize === 0) {
      // Refresh once before returning empty so newly-populated stores
      // (e.g. legacy migration just finished) are visible to callers.
      try {
        this.cachedSize = await this.store.size();
      } catch {
        this.cachedSize = 0;
      }
      if (this.cachedSize === 0) return [];
    }

    if (!(await this.ensureProviderReady())) return [];

    try {
      const [queryVector] = await this.provider.embed([queryText]);
      if (!queryVector || queryVector.length === 0) {
        log.warn('query embedding failed: empty vector');
        return [];
      }

      const overscan = excludeUrls && excludeUrls.size > 0
        ? Math.max(topK + excludeUrls.size, topK * 2)
        : topK;
      const hits = await this.store.search(queryVector, overscan);

      const results: SimilarResult[] = [];
      for (const hit of hits) {
        if (excludeUrls?.has(hit.id)) continue;
        results.push({ url: hit.id, score: hit.score });
        if (results.length >= topK) break;
      }
      return results;
    } catch (err) {
      log.warn('findSimilar failed', { error: String(err) });
      return [];
    }
  }

  shutdown(): void {
    try {
      this.knownUrls.clear();
      this.cachedSize = 0;
      this.store = null;
      this.available = false;
      this.providerVerified = false;
      this.readyPromise = null;
      this.loadAttempts = 0;
      this.lastFailureAt = 0;
      this.latchedOff = false;
      log.info('EmbeddingService shut down');
    } catch (err) {
      log.error('EmbeddingService shutdown error', { error: String(err) });
    }
  }

  private async migrateLegacyEmbeddings(): Promise<void> {
    if (!this.store) return;
    const legacy = getAllEmbeddings(this.provider.modelId);
    if (legacy.length === 0) {
      this.cachedSize = 0;
      return;
    }

    const records: VectorRecord[] = [];
    for (const row of legacy) {
      if (!row.embedding || row.dims <= 0) continue;
      try {
        const vector = new Float32Array(
          row.embedding.buffer.slice(
            row.embedding.byteOffset,
            row.embedding.byteOffset + row.dims * Float32Array.BYTES_PER_ELEMENT,
          ),
        );
        records.push({
          id: row.normalizedUrl,
          vector,
          metadata: {
            url: row.normalizedUrl,
            contentHash: '',
            modelId: row.model,
          },
        });
        this.knownUrls.add(row.normalizedUrl);
      } catch (err) {
        log.warn('legacy embedding migration: failed to decode vector', {
          url: row.normalizedUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (records.length === 0) {
      this.cachedSize = 0;
      return;
    }

    log.info('migrating embeddings into sqlite-vec store', { count: records.length });
    await this.store.upsert(records);
    this.cachedSize = await this.store.size();
  }
}

let globalInstance: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (!globalInstance) {
    globalInstance = new EmbeddingService();
  }
  return globalInstance;
}

export function resetEmbeddingService(): void {
  if (globalInstance) {
    globalInstance.shutdown();
    globalInstance = null;
  }
}
