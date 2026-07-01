import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config.js';

const log = createLogger('search');

interface BraveImageProperties {
  url?: string;
  placeholder?: string;
}

interface BraveImageRawResult {
  title?: string;
  url?: string;
  source?: string;
  properties?: BraveImageProperties;
  thumbnail?: { src?: string; original?: string };
  width?: number;
  height?: number;
  page_age?: string;
  age?: string;
}

interface BraveImageBody {
  results?: BraveImageRawResult[];
}

// Brave Search Image API — opt-in via BRAVE_API_KEY (same env as the web
// engine so users only configure one secret). The endpoint `images/search`
// returns:
//   {
//     results: [{
//       title, url (source page), source,
//       properties: { url: <image asset URL>, placeholder },
//       thumbnail: { src: <preview URL> },
//       width, height
//     }, ...]
//   }
// We surface the asset on `image_url`, preview on `thumbnail_url`, source
// page on `url`. Paired with DDG Image so category=images is supported.
//
// Auth model: throws a string with the literal `BRAVE_API_KEY` token so
// `buildEngineWarnings` can detect the env-var name in `engine_warnings`
// and surface a `missing_api_key` hint to callers without the orchestrator
// hard-coding adapter internals.
export class BraveImageEngine implements SearchEngine {
  name = 'brave-image';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const apiKey = getConfig().braveApiKey;
    if (!apiKey) {
      throw new Error(
        'BRAVE_API_KEY not set — set the env var to enable Brave image search',
      );
    }
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = Math.min(options.maxResults ?? 10, 100);

    const params = new URLSearchParams({
      q: query,
      count: String(maxResults),
      safesearch: 'moderate',
    });
    const lang = (options.language ?? '').slice(0, 2).toLowerCase();
    if (lang) params.set('search_lang', lang);
    if (options.country) params.set('country', options.country.toUpperCase());

    const url = `https://api.search.brave.com/res/v1/images/search?${params}`;

    log.debug('brave-image: querying api', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'X-Subscription-Token': apiKey,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) throw new Error(`Brave image returned ${response.status}`);

    const body = (await response.json()) as BraveImageBody;
    return this.parseResults(body, maxResults);
  }

  parseResults(body: unknown, maxResults: number): RawSearchResult[] {
    if (!body || typeof body !== 'object') return [];
    const items = (body as BraveImageBody).results;
    if (!Array.isArray(items)) return [];

    const total = Math.min(items.length, maxResults);
    const out: RawSearchResult[] = [];
    for (let i = 0; i < total; i++) {
      const item = items[i];
      if (!item) continue;
      const source = typeof item.url === 'string' ? item.url : '';
      const imageUrl = typeof item.properties?.url === 'string' ? item.properties.url : '';
      if (!source || !imageUrl) continue;

      const thumb = item.thumbnail?.src ?? item.thumbnail?.original;
      const hasW = typeof item.width === 'number' && item.width > 0;
      const hasH = typeof item.height === 'number' && item.height > 0;
      const bothDims = hasW && hasH;

      const result: RawSearchResult = {
        title: item.title || item.source || imageUrl,
        url: source,
        snippet: item.source ?? '',
        relevance_score: 1 - i / Math.max(items.length, 1),
        engine: 'brave-image',
        image_url: imageUrl,
      };
      if (typeof thumb === 'string' && thumb.length > 0) {
        result.thumbnail_url = thumb;
      }
      if (bothDims) {
        result.width = item.width;
        result.height = item.height;
      }
      out.push(result);
    }
    return out;
  }
}
