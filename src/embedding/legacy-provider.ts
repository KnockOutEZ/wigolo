import { randomUUID } from 'node:crypto';
import type { EmbedProvider } from '../providers/embed-provider.js';
import { EmbeddingSubprocess } from './subprocess.js';
import { getConfig } from '../config.js';

/**
 * Legacy embedding adapter — wraps the existing sentence-transformers
 * subprocess. Pure structural adapter: converts the batch-of-strings
 * interface to the subprocess's one-at-a-time call and number[] →
 * Float32Array conversion. Behavior is otherwise unchanged.
 */
export class LegacyEmbedProvider implements EmbedProvider {
  private subprocess: EmbeddingSubprocess;

  constructor() {
    this.subprocess = new EmbeddingSubprocess();
  }

  get modelId(): string {
    return this.subprocess.getModel() ?? getConfig().embeddingModel;
  }

  get dim(): number {
    const d = this.subprocess.getDims();
    if (d === null) throw new Error('LegacyEmbedProvider: dim accessed before warmup completed');
    return d;
  }

  /** Force subprocess READY handshake so getDims() returns a real number. */
  async warmup(): Promise<void> {
    await this.subprocess.embed(randomUUID(), 'warmup');
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) {
      const response = await this.subprocess.embed(randomUUID(), text);
      if (!response.vector || response.error) {
        throw new Error(response.error ?? 'embedding subprocess returned no vector');
      }
      out.push(Float32Array.from(response.vector));
    }
    return out;
  }
}
