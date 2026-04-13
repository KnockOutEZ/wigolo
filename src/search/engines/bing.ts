import { parseHTML } from 'linkedom';
import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

export function decodeBingTrackerUrl(href: string): string {
  let u: URL;
  try { u = new URL(href); } catch { return href; }
  if (!u.hostname.endsWith('bing.com') || u.pathname !== '/ck/a') return href;

  const encoded = u.searchParams.get('u');
  if (!encoded || encoded.length < 4) return href;

  // Bing format: 2-char prefix (commonly "a1") + URL-safe base64 of the destination.
  const trimmed = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
  const padded = trimmed + '='.repeat((4 - trimmed.length % 4) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    new URL(decoded);
    return decoded;
  } catch {
    return href;
  }
}

export class BingEngine implements SearchEngine {
  name = 'bing';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({ q: query });
    const url = `https://www.bing.com/search?${params}`;

    log.debug('scraping bing', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': options.language ?? 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) throw new Error(`Bing returned ${response.status}`);

    const html = await response.text();
    return this.parseResults(html, maxResults);
  }

  parseResults(html: string, maxResults: number): RawSearchResult[] {
    const { document } = parseHTML(html);
    const results: RawSearchResult[] = [];

    const items = document.querySelectorAll('li.b_algo');
    const total = Math.min(items.length, maxResults);

    for (let i = 0; i < total; i++) {
      const item = items[i];
      const link = item.querySelector('h2 a');
      const snippetEl = item.querySelector('.b_lineclamp2, .b_lineclamp3, .b_caption p');

      const rawHref = link?.getAttribute('href');
      const href = rawHref ? decodeBingTrackerUrl(rawHref) : undefined;
      const title = link?.textContent?.trim();

      if (href && title) {
        results.push({
          title,
          url: href,
          snippet: snippetEl?.textContent?.trim() ?? '',
          relevance_score: 1 - i / Math.max(items.length, 1),
          engine: 'bing',
        });
      }
    }

    return results;
  }
}
