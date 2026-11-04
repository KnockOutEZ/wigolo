import type { Config } from '../config.js';
import type { EmbedProvider } from '../providers/embed-provider.js';
import { resolveRemoteBase } from '../providers/remote-endpoint.js';

/**
 * The sqlite-vec table stores `float[384]`, and the bundled BGE model also
 * produces 384 values. A remote model must match, or the insert fails.
 */
export const REMOTE_EMBED_DIM = 384;

/** One response holds one vector per input. 1 MiB covers a large batch. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

type RemoteEmbedItem = { index?: unknown; embedding?: unknown };

/** Read a response body, but never buffer more than `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Remote embedding response exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * OpenAI-compatible `POST <base>/embeddings` adapter.
 *
 * The request sends `{ model, input: string[] }`. The response must carry one
 * vector per input, in `data[].embedding`, with an optional `index`. Vectors
 * must hold exactly 384 finite float32 numbers.
 */
export class RemoteEmbedProvider implements EmbedProvider {
  /**
   * Provenance id, not the request model. It includes the endpoint, because
   * two services can serve the same model name with different weights. Vector
   * rows record this id, and `findSimilar` filters by it, so spaces never mix.
   */
  readonly modelId: string;
  readonly dim = REMOTE_EMBED_DIM;
  private readonly requestModel: string;
  private readonly url: string;

  constructor(private readonly config: Config) {
    const base = resolveRemoteBase(config.embeddingApiBase, {
      label: 'Remote embedding provider',
      varName: 'WIGOLO_EMBEDDING_API_BASE',
      keyVarName: 'WIGOLO_EMBEDDING_API_KEY',
      apiKey: config.embeddingApiKey,
    });
    const endpoint = new URL(base);
    this.url = `${base}/embeddings`;
    this.requestModel = config.embeddingModel;
    this.modelId = `${config.embeddingModel} @ ${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`;
  }

  /**
   * The provider keeps no local model, so warmup is a single probe call. It
   * turns a bad URL, a missing model, or a dimension mismatch into a clear
   * error before the first cache write.
   */
  async warmup(): Promise<void> {
    await this.embed(['wigolo warmup']);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.embeddingApiKey) headers.Authorization = `Bearer ${this.config.embeddingApiKey}`;

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.requestModel, input: texts }),
        signal: AbortSignal.timeout(this.config.embeddingRequestTimeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : 'unknown network error')
        .replaceAll(this.config.embeddingApiKey || '\0', '[redacted]');
      throw new Error(`Remote embedding request failed: ${reason}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Remote embedding HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readCapped(response, MAX_RESPONSE_BYTES));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Remote embedding response exceeded')) throw err;
      throw new Error('Remote embedding returned invalid JSON');
    }
    if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
      throw new Error('Remote embedding response must contain a data array');
    }
    const items = payload.data as unknown[];
    if (items.length !== texts.length) {
      throw new Error(
        `Remote embedding returned ${items.length} vectors for ${texts.length} inputs`,
      );
    }

    const vectors: Float32Array[] = new Array<Float32Array>(texts.length);
    const seen = new Set<number>();
    items.forEach((item, position) => {
      if (!item || typeof item !== 'object') throw new Error('Remote embedding item must be an object');
      const { index, embedding } = item as RemoteEmbedItem;
      // OpenAI returns an index for each vector. A server that omits it is
      // read in array order, which is the same contract for a full batch.
      const slot = index === undefined ? position : index;
      if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= texts.length) {
        throw new Error('Remote embedding returned an out-of-range index');
      }
      const i = slot as number;
      if (seen.has(i)) throw new Error('Remote embedding returned a duplicate index');
      seen.add(i);
      if (!Array.isArray(embedding) || embedding.length !== REMOTE_EMBED_DIM) {
        const got = Array.isArray(embedding) ? embedding.length : 'non-array';
        throw new Error(`Remote embedding must return ${REMOTE_EMBED_DIM} dimensions (got ${got})`);
      }
      const vector = new Float32Array(REMOTE_EMBED_DIM);
      for (let k = 0; k < REMOTE_EMBED_DIM; k += 1) {
        const value = embedding[k];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error('Remote embedding returned a non-finite or missing value');
        }
        vector[k] = value;
        // A finite JSON number can still overflow float32 (1e100 becomes
        // Infinity), so check the stored value, not only the input.
        if (!Number.isFinite(vector[k])) {
          throw new Error('Remote embedding returned a value outside the float32 range');
        }
      }
      vectors[i] = vector;
    });
    return vectors;
  }
}