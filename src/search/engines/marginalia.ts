import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

interface MarginaliaRawResult {
  url?: string;
  title?: string;
  description?: string;
  quality?: number;
  rankingScore?: number;
  domainHash?: number;
}

interface MarginaliaBody {
  results?: MarginaliaRawResult[];
}

// Marginalia is a non-commercial search engine focused on the long-tail
// small web — pages the major engines either deprioritize or don't crawl.
// Adding it to the general vertical broadens recall for niche / legacy
// queries that S11a is designed to surface. Free JSON API, no key.
//
// Endpoint shape: `https://api2.marginalia-search.com/search?query=<q>&count=N&dc=N`
// with header `API-Key: public` (the legacy api.marginalia-search.com
// path-segment API now 404s). 503 means rate-limited — let it throw so the
// breaker counts it.
// Returns `{ results: [{ url, title, description, quality, rankingScore }] }`.
// We normalize to RawSearchResult, preserving the engine's own ordering as
// the relevance signal (a `rankingScore` fallback is used when present).
export class MarginaliaEngine implements SearchEngine {
  name = 'marginalia';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({ query, count: String(maxResults), dc: '3' });
    const url = `https://api2.marginalia-search.com/search?${params}`;

    log.debug('querying marginalia', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'wigolo/0.1 (https://github.com/staticn0va/wigolo)',
        Accept: 'application/json',
        'API-Key': 'public',
      },
    });
    if (!response.ok) throw new Error(`Marginalia returned ${response.status}`);

    const body = (await response.json()) as MarginaliaBody;
    return this.parseResults(body, maxResults);
  }

  parseResults(body: unknown, maxResults: number): RawSearchResult[] {
    if (!body || typeof body !== 'object') return [];
    const items = (body as MarginaliaBody).results;
    if (!Array.isArray(items)) return [];

    const total = Math.min(items.length, maxResults);
    const out: RawSearchResult[] = [];
    for (let i = 0; i < total; i++) {
      const item = items[i];
      if (!item) continue;
      const url = typeof item.url === 'string' ? item.url : '';
      const title = typeof item.title === 'string' ? item.title : '';
      if (!url || !title) continue;

      out.push({
        title,
        url,
        snippet: typeof item.description === 'string' ? item.description : '',
        relevance_score: 1 - i / Math.max(items.length, 1),
        engine: 'marginalia',
      });
    }
    return out;
  }
}
