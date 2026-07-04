import { parseHTML } from 'linkedom';
import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';
import { nextUserAgent, isBlockedError } from './user-agents.js';

const log = createLogger('search');

// Mojeek runs a real independent web index — no Bing/Google reliance. Adding
// it to the general vertical adds an independent lexical signal that dilutes
// brand-collision outcomes from the major engines (a long-tail goal of
// S11a). Free HTML search; no API key required for basic queries.
//
// Request shape mirrors SearXNG's proven mojeek adapter: no `fmt` param
// (never sent for web search), `safe=0`, and no explicit `s` offset on page 1
// (sending `s=0` triggers rate-limiting). Mojeek 403s are IP-reputation /
// rate-limit driven; on a block the engine rotates its browser fingerprint
// (a shared UA pool) on retry, which clears many transient blocks.
export class MojeekEngine implements SearchEngine {
  name = 'mojeek';
  private userAgent = nextUserAgent();

  onRetry(_attempt: number, lastError: unknown): void {
    if (isBlockedError(lastError)) this.userAgent = nextUserAgent(this.userAgent);
  }

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({ q: query, safe: '0' });
    const url = `https://www.mojeek.com/search?${params}`;

    log.debug('scraping mojeek', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) throw new Error(`Mojeek returned ${response.status}`);

    const html = await response.text();
    return this.parseResults(html, maxResults);
  }

  parseResults(html: string, maxResults: number): RawSearchResult[] {
    if (!html || html.length === 0) return [];
    const { document } = parseHTML(html);
    const items = document.querySelectorAll('ul.results-standard li, .results .result');
    const results: RawSearchResult[] = [];
    const total = Math.min(items.length, maxResults);
    for (let i = 0; i < total; i++) {
      const item = items[i];
      // Mojeek's anchor selector varies slightly across page variants. Try
      // the documented one first and fall back to the first <a> within the
      // <h2> heading.
      const titleAnchor =
        item.querySelector('a.title, h2 a.title, h2 a') ?? item.querySelector('a');
      const snippetEl = item.querySelector('p.s, .description');
      const href = titleAnchor?.getAttribute('href') ?? '';
      const title = titleAnchor?.textContent?.trim() ?? '';
      if (!href || !title) continue;

      results.push({
        title,
        url: href,
        snippet: snippetEl?.textContent?.trim() ?? '',
        relevance_score: 1 - i / Math.max(items.length, 1),
        engine: 'mojeek',
      });
    }
    return results;
  }
}
