import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../types.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

interface SearxngApiResult {
  title: string;
  url: string;
  content: string;
  score?: number | null;
  engine: string;
  engines: string[];
}

interface SearxngApiResponse {
  results: SearxngApiResult[];
  query: string;
  number_of_results: number;
}

export class SearxngClient implements SearchEngine {
  name = 'searxng';

  constructor(private readonly baseUrl: string) {}

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const config = getConfig();
    const timeoutMs = options.timeoutMs ?? config.searxngQueryTimeoutMs;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      q: query,
      format: 'json',
      pageno: '1',
    });

    if (options.timeRange) params.set('time_range', options.timeRange);
    if (options.language) params.set('language', options.language);

    const url = `${this.baseUrl}/search?${params}`;
    log.debug('querying searxng', { query, url });

    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}`);
    }

    const data = (await response.json()) as SearxngApiResponse;
    const total = data.results.length;

    return data.results.slice(0, maxResults).map((r, i) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      relevance_score: r.score != null ? Math.min(r.score, 1) : 1 - i / Math.max(total, 1),
      engine: 'searxng',
    }));
  }
}
