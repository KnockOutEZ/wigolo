import { parseHTML } from 'linkedom';
import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

// DDG Lite sometimes prefixes snippets with dates like "Jan 15, 2025 -" or "2025-01-15 ·"
const DATE_SNIPPET_PATTERN = /^(\w{3}\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})\s*[·—–-]/;

function parseDateFromSnippet(snippet: string): string | undefined {
  const match = snippet.trim().match(DATE_SNIPPET_PATTERN);
  if (!match) return undefined;
  const d = new Date(match[1]);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

export class DuckDuckGoEngine implements SearchEngine {
  name = 'duckduckgo';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({ q: query });
    const url = `https://lite.duckduckgo.com/lite/?${params}`;

    log.debug('scraping duckduckgo', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] },
    });

    if (!response.ok) throw new Error(`DDG returned ${response.status}`);

    const html = await response.text();
    return this.parseResults(html, maxResults);
  }

  parseResults(html: string, maxResults: number): RawSearchResult[] {
    const { document } = parseHTML(html);
    const results: RawSearchResult[] = [];

    const links = document.querySelectorAll('a.result-link');
    const snippets = document.querySelectorAll('.result-snippet');

    const total = Math.min(links.length, maxResults);

    for (let i = 0; i < total; i++) {
      const link = links[i];
      const snippet = snippets[i];
      const href = link?.getAttribute('href');
      const title = link?.textContent?.trim();

      if (href && title) {
        const snippetText = snippet?.textContent?.trim() ?? '';
        const published_date = parseDateFromSnippet(snippetText);

        results.push({
          title,
          url: href,
          snippet: snippetText,
          relevance_score: 1 - i / Math.max(links.length, 1),
          engine: 'duckduckgo',
          ...(published_date ? { published_date } : {}),
        });
      }
    }

    return results;
  }
}
