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
 * Phase 5 replaced the in-memory VectorIndex with the sqlite-vec backed
 * store accessed via getVectorStore(). The public surface (init /
 * embedAndStore / embedAsync / findSimilar / getIndex / isAvailable /
 * shutdown) is unchanged so callers in server.ts, tools/fetch.ts,
 * research/pipeline.ts, search/find-similar.ts, and the legacy SearXNG
 * orchestrator continue to work without modification.
 */
export class EmbeddingService {
  private provider: EmbedProvider;
  private store: VectorStore | null = null;
  private knownUrls = new Set<string>();
  private available = false;
  private providerVerified = false;

  constructor(provider?: EmbedProvider) {
    this.provider = provider ?? new FastembedEmbedProvider();
  }

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

      // Mark available now and probe the provider in the BACKGROUND. The probe loads the ONNX
      // model (a cold data dir DOWNLOADS it) — awaiting it here blocked the MCP `initialize`
      // response indefinitely on first run, and this is the SHARED initSubsystems path (stdio
      // `mcp`, `serve`, and the studio host's daemon.start all await it). The provider lazy-loads
      // on first real embed regardless; the probe only confirms it works and flips
      // providerVerified, which gates `find_similar` alone (it returns empty until verified).
      this.available = true;
      void this.provider
        .embed(['embedding service probe'])
        .then(() => {
          this.providerVerified = true;
          log.info('embedding provider verified', { modelId: this.provider.modelId, dim: this.provider.dim });
        })
        .catch((err) => {
          this.providerVerified = false;
          log.warn('embedding provider probe failed — embeddings degraded until the model loads', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err) {
      log.error('EmbeddingService init failed', { error: String(err) });
      this.available = false;
    }
  }

  isAvailable(): boolean {
    return this.available;
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

    try {
      const [vector] = await this.provider.embed([markdown]);
      if (!vector || vector.length === 0) {
        log.warn('embedding returned empty vector', { url });
        return;
      }
      // A successful real embed proves the provider works → self-heal providerVerified if the
      // async probe lost the race or failed. This is the load-bearing self-heal: embedAndStore is
      // gated on `available` (not providerVerified), so background indexing reaches it even when
      // the probe failed. (findSimilar does NOT self-heal — its only caller gates on
      // isSubprocessReady() upstream, so it's unreachable with providerVerified=false anyway.)
      this.providerVerified = true;

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
