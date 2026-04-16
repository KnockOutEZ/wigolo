import { parseHTML } from 'linkedom';
import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const DATE_SNIPPET_PATTERN = /^(\w{3}\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})\s*[·—–-]/;

function parseDateFromEl(el: { textContent?: string | null } | null): string | undefined {
  if (!el?.textContent) return undefined;
  const text = el.textContent.trim();
  const d = new Date(text);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function parseDateFromSnippet(snippet: string): string | undefined {
  const match = snippet.trim().match(DATE_SNIPPET_PATTERN);
  if (!match) return undefined;
  const d = new Date(match[1]);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

export class StartpageEngine implements SearchEngine {
  name = 'startpage';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({ query, cat: 'web' });
    const url = `https://www.startpage.com/sp/search?${params}`;

    log.debug('scraping startpage', { query });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) throw new Error(`Startpage returned ${response.status}`);

    const html = await response.text();
    return this.parseResults(html, maxResults);
  }

  parseResults(html: string, maxResults: number): RawSearchResult[] {
    const { document } = parseHTML(html);
    const results: RawSearchResult[] = [];

    const items = document.querySelectorAll('.w-gl__result');
    const total = Math.min(items.length, maxResults);

    for (let i = 0; i < total; i++) {
      const item = items[i];
      const link = item.querySelector('.w-gl__result-title, a.w-gl__result-url');
      const snippetEl = item.querySelector('.w-gl__description');

      const href = link?.getAttribute('href');
      const title = link?.textContent?.trim();

      if (href && title) {
        // Startpage sometimes shows dates in a dedicated element or snippet prefix
        const dateEl = item.querySelector('.w-gl__result-date, time');
        const snippetText = snippetEl?.textContent?.trim() ?? '';
        const published_date = parseDateFromEl(dateEl) ?? parseDateFromSnippet(snippetText);

        results.push({
          title,
          url: href,
          snippet: snippetText,
          relevance_score: 1 - i / Math.max(items.length, 1),
          engine: 'startpage',
          ...(published_date ? { published_date } : {}),
        });
      }
    }

    return results;
  }
}
