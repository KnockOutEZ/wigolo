import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

// MediaWiki's opensearch API: free, no key, returns titles + snippets + URLs in
// a fixed 4-array shape. Useful as a low-weight authoritative signal in the
// general vertical — encyclopedic results dilute lexical brand collisions
// from Bing/DDG when the query is a real subject (e.g. "next" → Next.js, not
// the UK retailer next.co.uk).
export class WikipediaEngine implements SearchEngine {
  name = 'wikipedia';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;
    const language = (options.language ?? 'en').slice(0, 2).toLowerCase();

    const params = new URLSearchParams({
      action: 'opensearch',
      format: 'json',
      search: query,
      limit: String(Math.min(Math.max(maxResults, 1), 20)),
      namespace: '0',
    });
    const url = `https://${language}.wikipedia.org/w/api.php?${params}`;

    log.debug('querying wikipedia opensearch', { query, language });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'wigolo/0.1 (https://github.com/staticn0va/wigolo)',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`);

    const body = await response.json();
    return this.parseResults(body, maxResults);
  }

  parseResults(body: unknown, maxResults: number): RawSearchResult[] {
    // OpenSearch shape: [query, titles[], snippets[], urls[]]
    if (!Array.isArray(body) || body.length < 4) return [];
    const titles = Array.isArray(body[1]) ? (body[1] as string[]) : [];
    const snippets = Array.isArray(body[2]) ? (body[2] as string[]) : [];
    const urls = Array.isArray(body[3]) ? (body[3] as string[]) : [];

    const total = Math.min(titles.length, urls.length, maxResults);
    const results: RawSearchResult[] = [];
    for (let i = 0; i < total; i++) {
      const title = titles[i];
      const url = urls[i];
      if (!title || !url) continue;
      results.push({
        title,
        url,
        snippet: snippets[i] ?? '',
        relevance_score: 1 - i / Math.max(titles.length, 1),
        engine: 'wikipedia',
      });
    }
    return results;
  }
}
