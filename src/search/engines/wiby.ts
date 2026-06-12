import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

// Wiby search: keyless JSON API over a tiny retro/personal-web index. The
// major engines deprioritize this corner of the web, so Wiby adds long-tail
// recall the rest of the general pool misses. Lowest tier by design — it is
// registered low-weight + secondary so it can only add coverage, never
// dominate consensus. Response is a JSON array with capitalized keys:
// [{ URL, Title, Snippet, Description }].
export class WibyEngine implements SearchEngine {
  name = 'wiby';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({ q: query });
    const url = `https://wiby.me/json/?${params}`;

    log.debug('querying wiby json api', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'wigolo/0.1 (https://github.com/staticn0va/wigolo)',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) throw new Error(`Wiby returned ${response.status}`);

    const body = await response.json();
    return this.parseResults(body, maxResults);
  }

  parseResults(body: unknown, maxResults: number): RawSearchResult[] {
    if (!Array.isArray(body)) return [];

    const results: RawSearchResult[] = [];
    for (let i = 0; i < body.length && results.length < maxResults; i++) {
      const item = body[i] as { URL?: unknown; Title?: unknown; Snippet?: unknown };
      const url = typeof item?.URL === 'string' ? item.URL : '';
      const title = typeof item?.Title === 'string' ? item.Title : '';
      // Untrusted payload — only pass through http(s) URLs (no javascript:,
      // data:, ftp:, or protocol-relative entries).
      if (!/^https?:\/\//i.test(url) || !title) continue;
      results.push({
        title,
        url,
        snippet: typeof item.Snippet === 'string' ? item.Snippet : '',
        relevance_score: 1 - i / Math.max(body.length, 1),
        engine: 'wiby',
      });
    }
    return results;
  }
}
