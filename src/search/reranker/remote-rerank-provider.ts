import type { Config } from '../../config.js';
import type { RerankCandidate, RerankProvider, RerankResult } from '../../providers/rerank-provider.js';

type RemoteResult = { index?: unknown; relevance_score?: unknown; score?: unknown };

/** Cohere-style POST /rerank adapter for a configured model service. */
export class RemoteRerankProvider implements RerankProvider {
  readonly modelId: string;
  private readonly url: string;

  constructor(private readonly config: Config) {
    const base = config.rerankApiBase?.trim().replace(/\/+$/, '');
    if (!base) throw new Error('Remote reranker requires WIGOLO_RERANK_API_BASE');
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new Error('WIGOLO_RERANK_API_BASE must be an http(s) URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('WIGOLO_RERANK_API_BASE must be an http(s) URL without credentials, query, or fragment');
    }
    if (config.rerankApiKey && parsed.protocol !== 'https:') {
      throw new Error('WIGOLO_RERANK_API_KEY requires HTTPS');
    }
    this.url = `${base}/rerank`;
    this.modelId = config.rerankerModel;
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = candidates.length): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    if (!Number.isInteger(topK) || topK < 0) throw new Error('Remote rerank topK must be a non-negative integer');
    if (topK === 0) return [];
    const topN = Math.min(topK, candidates.length);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.rerankApiKey) headers.Authorization = `Bearer ${this.config.rerankApiKey}`;

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.modelId, query, documents: candidates.map((c) => c.text), top_n: topN }),
        signal: AbortSignal.timeout(this.config.rerankerRequestTimeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : 'unknown network error')
        .replaceAll(this.config.rerankApiKey || '\0', '[redacted]');
      throw new Error(`Remote rerank request failed: ${reason}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Remote rerank HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Remote rerank returned invalid JSON');
    }
    if (!payload || typeof payload !== 'object' || !('results' in payload) || !Array.isArray(payload.results)) {
      throw new Error('Remote rerank response must contain a results array');
    }
    if (payload.results.length !== topN) throw new Error('Remote rerank returned an unexpected number of results');
    const seen = new Set<number>();
    const scored = payload.results.map((item: unknown): RerankResult => {
      if (!item || typeof item !== 'object') throw new Error('Remote rerank result must be an object');
      const { index, relevance_score, score } = item as RemoteResult;
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= candidates.length) {
        throw new Error('Remote rerank returned an out-of-range index');
      }
      const i = index as number;
      if (seen.has(i)) throw new Error('Remote rerank returned a duplicate index');
      seen.add(i);
      const value = relevance_score ?? score;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('Remote rerank returned a non-finite or missing score');
      }
      return { id: candidates[i].id, score: value };
    });
    return scored.sort((a, b) => b.score - a.score);
  }
}
