import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

// User-agent rotation matches the legacy DuckDuckGoEngine — DDG serves an
// older, more parseable HTML page when a desktop browser UA is set.
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

// DDG embeds the vqd token in two shapes depending on the page variant.
// `vqd='3-12345abcdef'` is the most common bootstrap shape; the alternate
// `vqd="..."` quoted form is occasionally returned by the JS-disabled route.
const VQD_PATTERN = /vqd=(?:['"])(\d+-[A-Za-z0-9_-]+)(?:['"])/;

interface DdgImageRawResult {
  title?: string;
  image?: string;
  thumbnail?: string;
  url?: string;
  width?: number;
  height?: number;
  source?: string;
}

interface DdgImageBody {
  results?: DdgImageRawResult[];
}

// DuckDuckGo image search. Zero-key path: the i.js JSON endpoint needs a
// `vqd` token bootstrapped from a regular DDG search page. The flow is:
//   1. GET https://duckduckgo.com/?q=<query>  → scrape vqd token from HTML
//   2. GET https://duckduckgo.com/i.js?q=<query>&vqd=<token>&o=json → JSON
// We surface the asset URL on `image_url`, the preview on `thumbnail_url`,
// and the SOURCE page on `url` so callers can navigate. Ensures
// category=images is supported on core (it previously returned unsupported).
export class DdgImageEngine implements SearchEngine {
  name = 'ddg-image';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = options.maxResults ?? 10;

    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    log.debug('ddg-image: bootstrapping vqd token', { query });
    const bootstrapUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;
    const bootstrap = await fetch(bootstrapUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': ua, 'Accept': 'text/html' },
    });
    if (!bootstrap.ok) throw new Error(`DDG image bootstrap returned ${bootstrap.status}`);
    const html = await bootstrap.text();
    const vqd = this.extractVqd(html);
    if (!vqd) throw new Error('DDG image bootstrap missing vqd token');

    // Build the i.js URL. Region+locale `kl` is wired from options.country if
    // present, falling back to us-en — matches the DuckDuckGoEngine pattern.
    const lang = (options.language ?? 'en').slice(0, 2).toLowerCase();
    const region = options.country ? `${options.country.toLowerCase()}-${lang}` : 'us-en';
    const ijsUrl =
      `https://duckduckgo.com/i.js?l=${region}` +
      `&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,,,&p=1`;

    log.debug('ddg-image: fetching i.js', { region });
    const response = await fetch(ijsUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': ua,
        'Accept': 'application/json',
        // DDG sets a strict referer check on i.js; without it the endpoint
        // returns an HTML error page that breaks JSON parsing.
        'Referer': 'https://duckduckgo.com/',
      },
    });
    if (!response.ok) throw new Error(`DDG image returned ${response.status}`);

    const body = (await response.json()) as DdgImageBody;
    return this.parseResults(body, maxResults);
  }

  /**
   * Extract the vqd bootstrap token from a DDG HTML page. Returns null when
   * the page does not carry one — callers should treat that as a hard
   * failure (no token, no JSON endpoint access).
   */
  extractVqd(html: string): string | null {
    const m = html.match(VQD_PATTERN);
    return m ? m[1] : null;
  }

  parseResults(body: unknown, maxResults: number): RawSearchResult[] {
    if (!body || typeof body !== 'object') return [];
    const items = (body as DdgImageBody).results;
    if (!Array.isArray(items)) return [];

    const total = Math.min(items.length, maxResults);
    const out: RawSearchResult[] = [];
    for (let i = 0; i < total; i++) {
      const item = items[i];
      if (!item) continue;
      const image = typeof item.image === 'string' ? item.image : '';
      const source = typeof item.url === 'string' ? item.url : '';
      if (!image || !source) continue;

      // Width+height only emitted when BOTH are present — a single dimension
      // can't drive layout and partial data is more confusing than useful.
      const hasW = typeof item.width === 'number' && item.width > 0;
      const hasH = typeof item.height === 'number' && item.height > 0;
      const bothDims = hasW && hasH;

      const result: RawSearchResult = {
        title: item.title || item.source || image,
        url: source,
        snippet: item.source ?? '',
        relevance_score: 1 - i / Math.max(items.length, 1),
        engine: 'ddg-image',
        image_url: image,
      };
      if (typeof item.thumbnail === 'string' && item.thumbnail.length > 0) {
        result.thumbnail_url = item.thumbnail;
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
