import { randomUUID } from 'node:crypto';
import { EmbeddingSubprocess } from './subprocess.js';
import { VectorIndex, type SimilarResult } from './vector-index.js';
import { updateCacheEmbedding, getAllEmbeddings, normalizeUrl } from '../cache/store.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('embedding');

export class EmbeddingService {
  private subprocess: EmbeddingSubprocess;
  private index: VectorIndex;
  private available = false;

  constructor() {
    this.subprocess = new EmbeddingSubprocess();
    this.index = new VectorIndex();
  }

  async init(): Promise<void> {
    try {
      const stored = getAllEmbeddings();
      if (stored.length > 0) {
        const entries = stored
          .filter(e => e.embedding && e.dims > 0)
          .map(e => ({
            url: e.normalizedUrl,
            embedding: e.embedding,
            dims: e.dims,
          }));
        const loaded = this.index.loadFromBuffers(entries);
        log.info('loaded embeddings into index', { count: loaded });
      }

      this.available = true;

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

  getIndex(): VectorIndex {
    return this.index;
  }

  async embedAndStore(url: string, markdown: string): Promise<void> {
    if (!this.available) {
      log.debug('embedding skipped: service not available', { url });
      return;
    }

    try {
      const requestId = randomUUID();
      const response = await this.subprocess.embed(requestId, markdown);

      if (!response.vector || response.error) {
        log.warn('embedding failed for URL', { url, error: response.error });
        return;
      }

      const vector = new Float32Array(response.vector);
      const buffer = Buffer.from(vector.buffer);
      const model = this.subprocess.getModel() ?? getConfig().embeddingModel;
      const dims = this.subprocess.getDims() ?? response.vector.length;

      let normalizedUrl: string;
      try {
        normalizedUrl = normalizeUrl(url);
      } catch {
        normalizedUrl = url;
      }

      updateCacheEmbedding(normalizedUrl, buffer, model, dims);
      this.index.add(normalizedUrl, vector);

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
    if (!this.available || this.index.size() === 0) {
      return [];
    }

    try {
      const requestId = randomUUID();
      const response = await this.subprocess.embed(requestId, queryText);

      if (!response.vector || response.error) {
        log.warn('query embedding failed', { error: response.error });
        return [];
      }

      const queryVector = new Float32Array(response.vector);
      return this.index.findSimilar(queryVector, topK, excludeUrls);
    } catch (err) {
      log.warn('findSimilar failed', { error: String(err) });
      return [];
    }
  }

  shutdown(): void {
    try {
      this.subprocess.shutdown();
      this.index.clear();
      this.available = false;
      log.info('EmbeddingService shut down');
    } catch (err) {
      log.error('EmbeddingService shutdown error', { error: String(err) });
    }
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
