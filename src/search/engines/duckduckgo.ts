import { parseHTML } from 'linkedom';
import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';
import { normalizeResultUrl } from '../url-unwrap.js';
import { nextUserAgent, isBlockedError } from './user-agents.js';

const log = createLogger('search');

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
  private userAgent = nextUserAgent();

  onRetry(_attempt: number, lastError: unknown): void {
    if (isBlockedError(lastError)) this.userAgent = nextUserAgent(this.userAgent);
  }

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({ q: query });
    if (options.country) {
      const lang = (options.language ?? 'en').slice(0, 2).toLowerCase();
      params.set('kl', `${options.country.toLowerCase()}-${lang}`);
    }
    const url = `https://lite.duckduckgo.com/lite/?${params}`;

    log.debug('scraping duckduckgo', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': this.userAgent },
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
          url: normalizeResultUrl(href),
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
