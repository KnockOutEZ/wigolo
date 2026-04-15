import { createLogger } from '../logger.js';

const log = createLogger('embedding');

export interface VectorEntry {
  url: string;
  vector: Float32Array;
}

export interface SimilarResult {
  url: string;
  score: number;
}

export class VectorIndex {
  private entries = new Map<string, Float32Array>();

  size(): number {
    return this.entries.size;
  }

  add(url: string, vector: Float32Array): void {
    this.entries.set(url, vector);
  }

  remove(url: string): boolean {
    return this.entries.delete(url);
  }

  has(url: string): boolean {
    return this.entries.has(url);
  }

  get(url: string): Float32Array | undefined {
    return this.entries.get(url);
  }

  findSimilar(queryVector: Float32Array, topK: number, excludeUrls?: Set<string>): SimilarResult[] {
    try {
      const results: SimilarResult[] = [];

      for (const [url, vector] of this.entries) {
        if (excludeUrls?.has(url)) continue;
        if (vector.length !== queryVector.length) continue;

        const score = cosineSimilarity(queryVector, vector);
        results.push({ url, score });
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, topK);
    } catch (err) {
      log.error('findSimilar failed', { error: String(err) });
      return [];
    }
  }

  clear(): void {
    this.entries.clear();
  }

  loadFromBuffers(entries: Array<{ url: string; embedding: Buffer; dims: number }>): number {
    let loaded = 0;
    for (const entry of entries) {
      try {
        const vector = new Float32Array(
          entry.embedding.buffer,
          entry.embedding.byteOffset,
          entry.dims,
        );
        this.entries.set(entry.url, vector);
        loaded++;
      } catch (err) {
        log.warn('failed to load vector', { url: entry.url, error: String(err) });
      }
    }
    return loaded;
  }

  getAllUrls(): string[] {
    return [...this.entries.keys()];
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dot / denominator;
}
