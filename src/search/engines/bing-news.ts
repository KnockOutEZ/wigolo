import { parseHTML } from 'linkedom';
import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { decodeBingTrackerUrl } from './bing.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

// Same relative-time fallback we use for the general engine. Bing news cards
// usually carry an explicit timestamp in .news_dt, but the snippet preamble
// is a useful backstop on cards where the date sits inside the body.
const RELATIVE_DATE_PATTERN = /^(\d+)\s+(day|hour|minute|week|month)s?\s+ago/i;
const ABSOLUTE_DATE_PATTERN = /(\w{3}\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})/;

function parseRelative(text: string): string | undefined {
  const m = text.trim().match(RELATIVE_DATE_PATTERN);
  if (!m) return undefined;
  const amount = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const now = new Date();
  if (unit.startsWith('day')) now.setDate(now.getDate() - amount);
  else if (unit.startsWith('hour')) now.setHours(now.getHours() - amount);
  else if (unit.startsWith('minute')) now.setMinutes(now.getMinutes() - amount);
  else if (unit.startsWith('week')) now.setDate(now.getDate() - amount * 7);
  else if (unit.startsWith('month')) now.setMonth(now.getMonth() - amount);
  return now.toISOString();
}

function parseAbsolute(text: string): string | undefined {
  const m = text.trim().match(ABSOLUTE_DATE_PATTERN);
  if (!m) return undefined;
  // YYYY-MM-DD parses as UTC midnight already; verbose "Jan 15, 2025" parses
  // as LOCAL midnight which shifts the ISO output across timezones. Force
  // UTC for the verbose form so test runs and prod queries agree.
  const raw = m[1];
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : `${raw} UTC`;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function parseDateFromNewsCard(dateText: string | null | undefined, snippet: string): string | undefined {
  const candidates: string[] = [];
  if (dateText) candidates.push(dateText);
  candidates.push(snippet);
  for (const c of candidates) {
    const rel = parseRelative(c);
    if (rel) return rel;
    const abs = parseAbsolute(c);
    if (abs) return abs;
  }
  return undefined;
}

// Bing news SERP — uses /search with `filters=tnews` so the SERP renders the
// news vertical. Real `news-card` elements live inside .news-card-body in
// modern markup; some legacy layouts use plain li.news-card. Try both.
export class BingNewsEngine implements SearchEngine {
  name = 'bing_news';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const params = new URLSearchParams({
      q: query,
      filters: 'tnews',
      form: 'YFNR', // news-specific form id surfaces the .news-card layout
    });
    // See BingEngine: pin market + UI language to English by default so a
    // non-US IP does not return locale-mixed results. Regional intent still
    // arrives via `country` (→ cc) which takes precedence over the default.
    if (options.country) {
      params.set('cc', options.country.toLowerCase());
    } else {
      params.set('mkt', 'en-US');
      params.set('setlang', 'en');
    }
    const url = `https://www.bing.com/search?${params}`;

    log.debug('scraping bing news', { query });

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': options.language ?? 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) throw new Error(`Bing News returned ${response.status}`);

    const html = await response.text();
    return this.parseResults(html, maxResults);
  }

  parseResults(html: string, maxResults: number): RawSearchResult[] {
    const { document } = parseHTML(html);
    const results: RawSearchResult[] = [];

    // Bing news markup variants:
    //   .news-card                      legacy news vertical card container
    //   .news-card-body, .nws_itm       modern layout
    //   .b_algo                         fallback when the news rail renders inline
    const items = document.querySelectorAll('.news-card, .news-card-body, .nws_itm, li.b_algo');
    const total = Math.min(items.length, maxResults);

    for (let i = 0; i < total; i++) {
      const item = items[i];

      const linkEl = item.querySelector('a.title, a[data-id], h2 a, h3 a, a.news-card-title');
      const rawHref = linkEl?.getAttribute('href');
      const href = rawHref ? decodeBingTrackerUrl(rawHref) : undefined;
      const title = linkEl?.textContent?.trim();

      const snippetEl = item.querySelector('.snippet, .news-card-body-text, .b_caption p, .news-snippet');
      const snippet = snippetEl?.textContent?.trim() ?? '';

      const dateEl = item.querySelector('.news_dt, .source time, time, span[aria-label*="ago" i]');
      const dateText = dateEl?.textContent ?? dateEl?.getAttribute('aria-label') ?? null;

      if (href && title) {
        const published_date = parseDateFromNewsCard(dateText, snippet);
        results.push({
          title,
          url: href,
          snippet,
          relevance_score: 1 - i / Math.max(items.length, 1),
          engine: this.name,
          ...(published_date ? { published_date } : {}),
        });
      }
    }

    return results;
  }
}
