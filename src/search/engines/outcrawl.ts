import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config.js';

const log = createLogger('search');

interface OutcrawlHit {
  title?: string;
  url?: string;
  snippet?: string;
  rank?: number;
}

interface OutcrawlSearchResponse {
  hits?: OutcrawlHit[];
}

// Outcrawl search API. Lives behind OUTCRAWL_API_KEY; the vertical constructors
// exclude the engine entirely when no key is configured, so this code only
// runs in opt-in deployments. Same shape as the Brave adapter: one POST, a
// ranked list of title/url/snippet hits.
export class OutcrawlEngine implements SearchEngine {
  name = 'outcrawl';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const apiKey = getConfig().outcrawlApiKey;
    if (!apiKey) {
      throw new Error('OUTCRAWL_API_KEY not set');
    }
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = Math.min(options.maxResults ?? 10, 20);

    log.debug('querying outcrawl api', { query });

    const response = await fetch('https://api.outcrawl.ai/v1/search', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, limit: maxResults }),
    });

    if (!response.ok) throw new Error(`Outcrawl returned ${response.status}`);

    const body = (await response.json()) as OutcrawlSearchResponse;
    return this.parseResults(body, maxResults);
  }

  parseResults(body: OutcrawlSearchResponse, maxResults: number): RawSearchResult[] {
    const items = body.hits ?? [];
    const total = Math.min(items.length, maxResults);
    const out: RawSearchResult[] = [];
    for (let i = 0; i < total; i++) {
      const item = items[i];
      if (!item?.url || !item?.title) continue;
      out.push({
        title: item.title,
        url: item.url,
        snippet: item.snippet ?? '',
        relevance_score: 1 - i / Math.max(items.length, 1),
        engine: 'outcrawl',
      });
    }
    return out;
  }
}
