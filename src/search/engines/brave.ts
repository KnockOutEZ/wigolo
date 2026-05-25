import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config.js';

const log = createLogger('search');

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
  thumbnail?: { src?: string; original?: string };
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

// Brave Search API. Lives behind BRAVE_API_KEY; the vertical constructor
// excludes the engine entirely when no key is configured, so this code only
// runs in opt-in deployments. Different lexical signal from Bing — useful for
// diluting Bing-side brand collisions when both Brave and the rest of the
// pool see the query.
export class BraveEngine implements SearchEngine {
  name = 'brave';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const apiKey = getConfig().braveApiKey;
    if (!apiKey) {
      throw new Error('BRAVE_API_KEY not set');
    }
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = Math.min(options.maxResults ?? 10, 20);

    const params = new URLSearchParams({
      q: query,
      count: String(maxResults),
    });
    const lang = (options.language ?? '').slice(0, 2).toLowerCase();
    if (lang) params.set('search_lang', lang);
    if (options.country) params.set('country', options.country.toUpperCase());

    const url = `https://api.search.brave.com/res/v1/web/search?${params}`;

    log.debug('querying brave api', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'X-Subscription-Token': apiKey,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) throw new Error(`Brave returned ${response.status}`);

    const body = (await response.json()) as BraveSearchResponse;
    return this.parseResults(body, maxResults);
  }

  parseResults(body: BraveSearchResponse, maxResults: number): RawSearchResult[] {
    const items = body.web?.results ?? [];
    const total = Math.min(items.length, maxResults);
    const out: RawSearchResult[] = [];
    for (let i = 0; i < total; i++) {
      const item = items[i];
      if (!item?.url || !item?.title) continue;
      const ageIso = parsePageAge(item.page_age ?? item.age);
      const thumb = item.thumbnail?.src ?? item.thumbnail?.original;
      out.push({
        title: item.title,
        url: item.url,
        snippet: item.description ?? '',
        relevance_score: 1 - i / Math.max(items.length, 1),
        engine: 'brave',
        ...(ageIso ? { published_date: ageIso } : {}),
        ...(thumb ? { image_url: thumb } : {}),
      });
    }
    return out;
  }
}

function parsePageAge(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}
