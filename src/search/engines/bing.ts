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

// Date patterns commonly found in Bing result snippets: "Jan 15, 2025", "2025-01-15", "3 days ago"
const DATE_SNIPPET_PATTERN = /^(\w{3}\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})\s*[·—–-]/;
const RELATIVE_DATE_PATTERN = /^(\d+)\s+(day|hour|minute|week|month)s?\s+ago/i;

function parseDateFromEl(el: { textContent?: string | null } | null): string | undefined {
  if (!el?.textContent) return undefined;
  const text = el.textContent.trim();
  const d = new Date(text);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function parseDateFromSnippet(snippet: string): string | undefined {
  const trimmed = snippet.trim();

  const absMatch = trimmed.match(DATE_SNIPPET_PATTERN);
  if (absMatch) {
    const d = new Date(absMatch[1]);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  const relMatch = trimmed.match(RELATIVE_DATE_PATTERN);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const now = new Date();
    if (unit.startsWith('day')) now.setDate(now.getDate() - amount);
    else if (unit.startsWith('hour')) now.setHours(now.getHours() - amount);
    else if (unit.startsWith('minute')) now.setMinutes(now.getMinutes() - amount);
    else if (unit.startsWith('week')) now.setDate(now.getDate() - amount * 7);
    else if (unit.startsWith('month')) now.setMonth(now.getMonth() - amount);
    return now.toISOString();
  }

  return undefined;
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
        // Bing sometimes shows dates in a <span class="news_dt"> or generic date text
        const dateEl = item.querySelector('.news_dt, span[aria-label]');
        const published_date = parseDateFromEl(dateEl) ?? parseDateFromSnippet(snippetEl?.textContent ?? '');

        results.push({
          title,
          url: href,
          snippet: snippetEl?.textContent?.trim() ?? '',
          relevance_score: 1 - i / Math.max(items.length, 1),
          engine: 'bing',
          ...(published_date ? { published_date } : {}),
        });
      }
    }

    return results;
  }
}
