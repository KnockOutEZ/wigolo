import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config.js';

const log = createLogger('search');

interface DeepSeekResult {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  rerank_score?: number;
  date?: string | null;
}

interface DeepSeekSearchResponse {
  results?: DeepSeekResult[];
}

// DeepSeek's in-house search API. Lives behind DEEPSEEK_API_KEY; the vertical
// constructors exclude the engine entirely when no key is configured, the same
// opt-in shape as BraveEngine. Different lexical signal from Bing — useful for
// diluting Bing-side brand collisions when both DeepSeek and the rest of the
// pool see the query.
export class DeepseekEngine implements SearchEngine {
  name = 'deepseek';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const apiKey = getConfig().deepseekApiKey;
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY not set');
    }
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = clampCount(options.maxResults ?? 10);

    log.debug('querying deepseek api', { query });

    const response = await fetch('https://api.deepseek.com/v1/tools/search', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, count: maxResults }),
    });

    if (!response.ok) throw new Error(`DeepSeek returned ${response.status}`);

    const body = (await response.json()) as DeepSeekSearchResponse;
    return this.parseResults(body, maxResults);
  }

  parseResults(body: DeepSeekSearchResponse, maxResults: number): RawSearchResult[] {
    const items = body.results ?? [];
    if (!Array.isArray(items)) return [];

    const total = Math.min(items.length, maxResults);
    const out: RawSearchResult[] = [];
    for (let i = 0; i < total; i++) {
      const item = items[i];
      if (!item?.url || !item?.title) continue;
      const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
      const date = typeof item.date === 'string' && item.date.trim() !== '' ? item.date : undefined;
      out.push({
        title: item.title,
        url: item.url,
        snippet: summary !== '' ? summary : (item.snippet ?? ''),
        // DeepSeek documents rerank_score on a 0-3 scale. Use it when present
        // and fall back to position the way the other API adapters do.
        relevance_score: Number.isFinite(item.rerank_score)
          ? Math.min(item.rerank_score! / 3, 1)
          : 1 - i / Math.max(items.length, 1),
        engine: 'deepseek',
        ...(date ? { published_date: date } : {}),
      });
    }
    return out;
  }
}

// DeepSeek rejects a count outside 1-50, so a caller asking for more would get
// an error instead of fewer results.
function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(50, Math.max(1, Math.floor(value)));
}
